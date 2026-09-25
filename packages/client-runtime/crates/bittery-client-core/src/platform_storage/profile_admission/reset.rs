use super::*;

pub(crate) use crate::protocol::ProfileAdmissionResetPhase as ResetPhase;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ProfileResetScope {
    CoreOnly {
        namespace_version: u8,
    },
    LegacyProfile {
        scope: crate::ProfileLegacyResetScope,
    },
}
crate::wire::map_only_serde!(ProfileResetScope);
impl ProfileResetScope {
    pub(crate) fn validate(&self) -> Result<(), RuntimeError> {
        match self {
            Self::CoreOnly {
                namespace_version: 1,
            } => Ok(()),
            Self::CoreOnly { .. } => Err(platform_storage_invariant(
                "Profile reset namespace version is unsupported",
            )),
            Self::LegacyProfile { scope } => scope.validate(),
        }
    }
    pub(crate) fn families(&self) -> Vec<ProfileSourceFamily> {
        match self {
            Self::CoreOnly { .. } => Vec::new(),
            Self::LegacyProfile { scope } => {
                scope.families.iter().map(|family| family.family).collect()
            }
        }
    }
}
impl ProfileAdmissionRecord {
    pub(crate) fn resetting(
        wipe_id: String,
        scope: ProfileResetScope,
    ) -> Result<Self, RuntimeError> {
        identity(&wipe_id)?;
        scope.validate()?;
        Ok(Self::Reset {
            version: 1,
            wipe_id,
            revision: 0,
            phase: ResetPhase::Wiping,
            remaining_families: scope.families(),
            scope,
        })
    }
    pub(crate) fn reset_phase(&self) -> Option<ResetPhase> {
        match self {
            Self::Reset { phase, .. } => Some(*phase),
            _ => None,
        }
    }
    pub(crate) fn reset_scope(&self) -> Option<&ProfileResetScope> {
        match self {
            Self::Reset { scope, .. } => Some(scope),
            _ => None,
        }
    }
    pub(crate) fn wipe_id(&self) -> Option<&str> {
        match self {
            Self::Reset { wipe_id, .. } => Some(wipe_id),
            _ => None,
        }
    }
    pub(crate) fn record_reset_family(
        &mut self,
        family: ProfileSourceFamily,
        absent: bool,
    ) -> Result<bool, RuntimeError> {
        let Self::Reset {
            phase: ResetPhase::Wiping,
            scope,
            remaining_families,
            revision,
            ..
        } = self
        else {
            return Err(platform_storage_invariant(
                "Profile reset cleanup requires Wiping",
            ));
        };
        let ordered = scope.families();
        if !ordered.contains(&family) {
            return Err(platform_storage_invariant(
                "Profile reset family is outside scope",
            ));
        }
        if absent == !remaining_families.contains(&family) {
            return Ok(false);
        }
        if absent {
            remaining_families.retain(|remaining| *remaining != family);
        } else {
            remaining_families.push(family);
            remaining_families.sort_by_key(|family| {
                ordered
                    .iter()
                    .position(|candidate| candidate == family)
                    .expect("validated reset family")
            });
        }
        *revision = revision
            .checked_add(1)
            .ok_or_else(|| platform_storage_invariant("Profile reset revision overflows"))?;
        Ok(true)
    }
    pub(crate) fn complete_reset(&mut self) -> Result<(), RuntimeError> {
        let Self::Reset {
            phase,
            remaining_families,
            revision,
            ..
        } = self
        else {
            return Err(platform_storage_invariant(
                "Profile reset record is missing",
            ));
        };
        if *phase != ResetPhase::Wiping || !remaining_families.is_empty() {
            return Err(platform_storage_invariant(
                "Profile reset cleanup is incomplete",
            ));
        }
        *revision = revision
            .checked_add(1)
            .ok_or_else(|| platform_storage_invariant("Profile reset revision overflows"))?;
        *phase = ResetPhase::Wiped;
        Ok(())
    }
    pub(super) fn validate_reset(
        &self,
        catalog_accounts: &[DeviceCatalogAccount],
    ) -> Result<(), RuntimeError> {
        let Self::Reset {
            version,
            wipe_id,
            phase,
            scope,
            remaining_families,
            ..
        } = self
        else {
            return Err(platform_storage_invariant(
                "Profile reset record is missing",
            ));
        };
        if *version != 1 {
            return Err(platform_storage_invariant(
                "Profile reset version is unsupported",
            ));
        }
        identity(wipe_id)?;
        scope.validate()?;
        let ordered = scope.families();
        let mut previous = None;
        for family in remaining_families {
            let position = ordered
                .iter()
                .position(|candidate| candidate == family)
                .ok_or_else(|| {
                    platform_storage_invariant("Profile reset remaining family is outside scope")
                })?;
            if previous.is_some_and(|previous| previous >= position) {
                return Err(platform_storage_invariant(
                    "Profile reset remaining families are inconsistent",
                ));
            }
            previous = Some(position);
        }
        if (*phase == ResetPhase::Wiping && !catalog_accounts.is_empty())
            || (*phase == ResetPhase::Wiped && !remaining_families.is_empty())
        {
            return Err(platform_storage_invariant(
                "Profile reset phase fields are inconsistent",
            ));
        }
        Ok(())
    }
}
