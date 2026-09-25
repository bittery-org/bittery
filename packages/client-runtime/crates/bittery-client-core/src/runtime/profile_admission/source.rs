use super::{super::startup_invariant, invoke_source_with_binary};
use crate::{
    AccountId, ProfileAccountCredentialField, ProfileAdmissionRequest, ProfileAdmissionResponse,
    ProfileGlobalCredentialField, ProfileSourceContinuation, ProfileSourceFamily,
    ProfileSourceManifestDigest, ProfileSourceManifestEntry, ProfileSourceManifestHeader,
    ProfileSourceObservation, ProfileSourcePresence, ProfileSourceSelector, ProfileSourceSnapshot,
    Runtime, RuntimeError, SerializedProfileAdmissionExecutor,
};
use zeroize::Zeroizing;

pub(super) struct SourceRead {
    pub(super) observation: ProfileSourceObservation,
    pub(super) bytes: Option<Zeroizing<Vec<u8>>>,
}

pub(super) struct DesktopSources {
    pub(super) store: SourceRead,
    pub(super) sync_store: SourceRead,
}

pub(super) struct Manifest {
    pub(super) header: ProfileSourceManifestHeader,
    pub(super) entries: Vec<ProfileSourceManifestEntry>,
}

impl Manifest {
    pub(super) fn desktop(
        snapshot: &ProfileSourceSnapshot,
        entries: Vec<ProfileSourceManifestEntry>,
        mut accounts: Vec<AccountId>,
    ) -> Result<Self, RuntimeError> {
        accounts.sort_by(|left, right| left.as_str().as_bytes().cmp(right.as_str().as_bytes()));
        let mut expected = vec![
            (
                ProfileSourceFamily::DesktopStore,
                ProfileSourceSelector::WholeFile {},
            ),
            (
                ProfileSourceFamily::DesktopSyncStore,
                ProfileSourceSelector::WholeFile {},
            ),
            (
                ProfileSourceFamily::DesktopCredentials,
                ProfileSourceSelector::GlobalCredential {
                    field: ProfileGlobalCredentialField::DeviceKey,
                },
            ),
        ];
        for account_id in accounts {
            for field in [
                ProfileAccountCredentialField::SecretKey,
                ProfileAccountCredentialField::SessionData,
                ProfileAccountCredentialField::JwtToken,
                ProfileAccountCredentialField::VaultKeys,
                ProfileAccountCredentialField::EncryptedPrivateKey,
            ] {
                expected.push((
                    ProfileSourceFamily::DesktopCredentials,
                    ProfileSourceSelector::AccountCredential {
                        account_id: account_id.clone(),
                        field,
                    },
                ));
            }
        }
        if entries.len() != expected.len()
            || entries
                .iter()
                .zip(expected)
                .any(|(entry, (family, selector))| {
                    entry.family != family || entry.selector != selector
                })
        {
            return Err(startup_invariant(
                "Legacy Desktop manifest coverage is incomplete",
            ));
        }
        let entry_count = u64::try_from(entries.len())
            .map_err(|_| startup_invariant("Profile source manifest entry count overflows"))?;
        let mut digest = ProfileSourceManifestDigest::new(
            snapshot.format,
            &snapshot.profile_identity,
            entry_count,
        )?;
        for entry in &entries {
            digest.append(entry)?;
        }
        Ok(Self {
            header: ProfileSourceManifestHeader {
                version: crate::PROFILE_SOURCE_MANIFEST_VERSION,
                format: snapshot.format,
                profile_identity: snapshot.profile_identity.clone(),
                recorded_capture_id: snapshot.capture_id.clone(),
                entry_count,
                entries_sha256: digest.finish()?,
            },
            entries,
        })
    }
}

pub(super) fn evidence(
    snapshot: &ProfileSourceSnapshot,
    family: ProfileSourceFamily,
    selector: ProfileSourceSelector,
    read: &SourceRead,
) -> Result<ProfileSourceManifestEntry, RuntimeError> {
    let inventory = snapshot
        .families
        .iter()
        .find(|item| item.family == family)
        .ok_or_else(|| startup_invariant("Profile source evidence has no family inventory"))?;
    ProfileSourceManifestEntry::from_evidence(
        snapshot.format,
        family,
        selector,
        read.observation.clone(),
        inventory.file_identity.clone(),
        read.bytes.as_ref().map_or(&[], |bytes| bytes.as_slice()),
    )
}

pub(super) async fn read_desktop_sources(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    snapshot: &ProfileSourceSnapshot,
) -> Result<DesktopSources, RuntimeError> {
    let store = read(
        runtime,
        executor,
        snapshot,
        ProfileSourceFamily::DesktopStore,
        ProfileSourceSelector::WholeFile {},
    )
    .await?;
    validate_file_inventory(snapshot, ProfileSourceFamily::DesktopStore, &store)?;

    let sync_store = read(
        runtime,
        executor,
        snapshot,
        ProfileSourceFamily::DesktopSyncStore,
        ProfileSourceSelector::WholeFile {},
    )
    .await?;
    validate_file_inventory(snapshot, ProfileSourceFamily::DesktopSyncStore, &sync_store)?;

    Ok(DesktopSources { store, sync_store })
}

/// Reads one exact source selector to completion. There is deliberately no aggregate source-size
/// limit: the primitive bounds each response independently and this owner grows only the one value
/// that its caller explicitly requested.
pub(super) async fn read(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    snapshot: &ProfileSourceSnapshot,
    family: ProfileSourceFamily,
    selector: ProfileSourceSelector,
) -> Result<SourceRead, RuntimeError> {
    let mut cursor = None;
    let mut offset = 0_u64;
    let mut observation = None;
    let mut collected: Option<Zeroizing<Vec<u8>>> = None;

    loop {
        runtime.ensure_not_closed()?;
        let requested_cursor = cursor.clone();
        let (response, binary) = invoke_source_with_binary(
            executor,
            ProfileAdmissionRequest::ReadSourcePage {
                snapshot_handle: snapshot.snapshot_handle.clone(),
                family,
                selector: selector.clone(),
                cursor: requested_cursor.clone(),
            },
        )
        .await?;
        runtime.ensure_not_closed()?;
        let ProfileAdmissionResponse::SourcePage(page) = response else {
            return Err(startup_invariant("Profile source did not return a page"));
        };
        page.validate_for(
            &snapshot.snapshot_handle,
            family,
            &selector,
            offset,
            observation.as_ref(),
            binary.as_ref().map(|bytes| bytes.as_slice()),
        )?;

        if observation.is_none() {
            observation = Some(page.observation.clone());
        }
        if let Some(binary) = binary {
            if let Some(bytes) = collected.as_mut() {
                bytes.try_reserve(binary.len()).map_err(|_| {
                    startup_invariant("Profile source value cannot fit in its reader")
                })?;
                bytes.extend_from_slice(&binary);
            } else {
                collected = Some(binary);
            }
        }
        offset = page
            .offset
            .checked_add(page.byte_length)
            .ok_or_else(|| startup_invariant("Profile source page offset overflows"))?;

        match page.continuation {
            ProfileSourceContinuation::End {} => {
                if collected
                    .as_ref()
                    .is_some_and(|bytes| u64::try_from(bytes.len()) != Ok(offset))
                {
                    return Err(startup_invariant(
                        "Profile source reader accumulated a different byte length",
                    ));
                }
                return Ok(SourceRead {
                    observation: observation.expect("a source read always consumes one page"),
                    bytes: collected,
                });
            }
            ProfileSourceContinuation::More { cursor: next } => {
                if requested_cursor.as_deref() == Some(next.as_str()) {
                    return Err(startup_invariant(
                        "Profile source continuation did not transition",
                    ));
                }
                cursor = Some(next);
            }
        }
    }
}

fn validate_file_inventory(
    snapshot: &ProfileSourceSnapshot,
    family: ProfileSourceFamily,
    source: &SourceRead,
) -> Result<(), RuntimeError> {
    let presence = snapshot
        .families
        .iter()
        .find(|inventory| inventory.family == family)
        .map(|inventory| inventory.presence)
        .ok_or_else(|| startup_invariant("Profile source file family was not inventoried"))?;
    let observed_presence = match &source.observation {
        ProfileSourceObservation::Missing {} => ProfileSourcePresence::Missing,
        ProfileSourceObservation::FileBytes { .. } => ProfileSourcePresence::Present,
        _ => {
            return Err(startup_invariant(
                "Profile source file returned a non-file observation",
            ));
        }
    };
    if presence != observed_presence {
        return Err(startup_invariant(
            "Profile source file changed after snapshot inventory",
        ));
    }
    Ok(())
}
