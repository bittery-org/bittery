use super::startup_invariant;
use crate::replica::{
    persistence_contract::snapshot_physical_keys, ReplicaInventoryContinuation, ReplicaPhysicalKey,
    ReplicaSnapshot,
};
use crate::{
    platform_storage::{
        PlatformStorageArea, PlatformStorageInventoryContinuation, PlatformStorageValue,
    },
    Runtime, RuntimeError,
};
use std::collections::BTreeSet;

pub(super) async fn replica(
    runtime: &Runtime,
    snapshots: &[ReplicaSnapshot],
) -> Result<Vec<ReplicaPhysicalKey>, RuntimeError> {
    let mut allowed = Vec::new();
    for snapshot in snapshots {
        allowed.extend(snapshot_physical_keys(snapshot)?);
    }
    allowed.sort_by(ReplicaPhysicalKey::physical_cmp);
    if allowed.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(startup_invariant(
            "Profile admission plan repeats a Replica key",
        ));
    }
    let mut present: Vec<ReplicaPhysicalKey> = Vec::new();
    let mut cursor = None;
    loop {
        runtime.ensure_not_closed()?;
        let page = runtime.replica.inventory_page(cursor.clone()).await?;
        runtime.ensure_not_closed()?;
        if present
            .last()
            .zip(page.entries.first())
            .is_some_and(|(last, first)| last.physical_cmp(first) != std::cmp::Ordering::Less)
        {
            return Err(startup_invariant(
                "Profile Replica inventory keys do not advance",
            ));
        }
        if page.entries.iter().any(|key| {
            allowed
                .binary_search_by(|candidate| candidate.physical_cmp(key))
                .is_err()
        }) {
            return Err(startup_invariant(
                "Profile admission found unexplained destination Replica records",
            ));
        }
        present.extend(page.entries);
        match page.continuation {
            ReplicaInventoryContinuation::End {} => return Ok(present),
            ReplicaInventoryContinuation::More { cursor: next } => {
                if cursor.as_ref() == Some(&next) {
                    return Err(startup_invariant(
                        "Profile Replica inventory did not make progress",
                    ));
                }
                cursor = Some(next);
            }
        }
    }
}

pub(super) async fn platform(
    runtime: &Runtime,
    allowed: &[PlatformStorageValue],
) -> Result<Vec<PlatformStorageValue>, RuntimeError> {
    let locations = allowed
        .iter()
        .map(|value| runtime.platform_storage.physical_location(value))
        .collect::<Result<Vec<_>, _>>()?;
    let mut groups: Vec<(Vec<PlatformStorageArea>, Vec<String>)> = Vec::new();
    for area in [
        PlatformStorageArea::DevicePlain,
        PlatformStorageArea::DeviceSecret,
        PlatformStorageArea::SessionSecret,
    ] {
        let mut continuation = None;
        let mut keys: Vec<String> = Vec::new();
        let mut backing_areas = None;
        let mut permitted = None;
        loop {
            runtime.ensure_not_closed()?;
            let page = runtime
                .platform_storage
                .list_keys(area, continuation.clone())
                .await?;
            runtime.ensure_not_closed()?;
            if backing_areas
                .as_ref()
                .is_some_and(|previous| previous != &page.backing_areas)
                || groups.iter().any(|(group, _)| {
                    group
                        .iter()
                        .any(|member| page.backing_areas.contains(member))
                        && group != &page.backing_areas
                })
            {
                return Err(startup_invariant(
                    "Profile platform inventory has inconsistent backing areas",
                ));
            }
            backing_areas = Some(page.backing_areas.clone());
            if keys
                .last()
                .zip(page.keys.first())
                .is_some_and(|(last, first)| last.as_bytes() >= first.as_bytes())
            {
                return Err(startup_invariant(
                    "Profile platform inventory keys do not advance",
                ));
            }
            let permitted = permitted.get_or_insert_with(|| {
                locations
                    .iter()
                    .filter(|(logical_area, _)| page.backing_areas.contains(logical_area))
                    .map(|(_, key)| key.as_str())
                    .collect::<BTreeSet<_>>()
            });
            if page
                .keys
                .iter()
                .any(|key| !permitted.contains(key.as_str()))
            {
                return Err(startup_invariant(
                    "Profile admission found unexplained destination platform records",
                ));
            }
            keys.extend(page.keys);
            match page.continuation {
                PlatformStorageInventoryContinuation::End {} => break,
                PlatformStorageInventoryContinuation::More { cursor } => {
                    if continuation.as_ref() == Some(&cursor) {
                        return Err(startup_invariant(
                            "Profile platform inventory did not make progress",
                        ));
                    }
                    continuation = Some(cursor);
                }
            }
        }
        let backing_areas = backing_areas.expect("a platform inventory always reads a first page");
        if let Some((_, original_keys)) = groups.iter().find(|(group, _)| group == &backing_areas) {
            if original_keys != &keys {
                return Err(startup_invariant(
                    "Profile platform inventory changed across aliased areas",
                ));
            }
        } else {
            groups.push((backing_areas, keys));
        }
    }
    Ok(allowed
        .iter()
        .zip(locations)
        .filter(|(_, (area, key))| {
            groups
                .iter()
                .any(|(group, keys)| group.contains(area) && keys.binary_search(key).is_ok())
        })
        .map(|(value, _)| value.clone())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        PlatformStorageArea as Area, PlatformStorageInventoryContinuation as Continuation,
        PlatformStorageInventoryFamily, PlatformStorageKeysPage, PlatformStorageRequest,
        PlatformStorageResponse, SerializedHttpExecutor, SerializedPlatformStorageExecutor,
        SerializedReplicaExecutor,
    };
    use async_trait::async_trait;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };
    use zeroize::Zeroizing;

    struct Ports(Mutex<VecDeque<(Area, Option<String>, PlatformStorageKeysPage)>>);
    #[async_trait]
    impl SerializedReplicaExecutor for Ports {
        async fn invoke(&self, _: String) -> Result<String, RuntimeError> {
            panic!("platform census cannot access Replica payloads")
        }
    }
    #[async_trait]
    impl SerializedHttpExecutor for Ports {
        async fn invoke(&self, _: Zeroizing<String>) -> Result<String, RuntimeError> {
            panic!("platform census cannot access HTTP")
        }
        fn cancel(&self, _: &str) {
            panic!("platform census cannot cancel HTTP")
        }
    }
    #[async_trait]
    impl SerializedPlatformStorageExecutor for Ports {
        async fn invoke(
            &self,
            request: Zeroizing<String>,
        ) -> Result<Zeroizing<String>, RuntimeError> {
            let PlatformStorageRequest::ListKeys {
                area, ref cursor, ..
            } = serde_json::from_str(&request).unwrap()
            else {
                panic!("physical census cannot read or write values")
            };
            let (expected_area, expected_cursor, page) =
                self.0.lock().unwrap().pop_front().expect("unexpected scan");
            assert_eq!((area, cursor), (expected_area, &expected_cursor));
            Ok(Zeroizing::new(
                serde_json::to_string(&PlatformStorageResponse::KeysPage(page)).unwrap(),
            ))
        }
    }

    fn page(areas: &[Area], keys: Vec<String>, more: Option<&str>) -> PlatformStorageKeysPage {
        PlatformStorageKeysPage {
            version: 1,
            family: PlatformStorageInventoryFamily::PlatformStorage,
            backing_areas: areas.to_vec(),
            keys,
            continuation: more.map_or(Continuation::End {}, |cursor| Continuation::More {
                cursor: cursor.into(),
            }),
        }
    }
    fn make_runtime() -> (Arc<Runtime>, Arc<Ports>) {
        let ports = Arc::new(Ports(Mutex::new(VecDeque::new())));
        (
            Runtime::with_serialized_executors(ports.clone(), ports.clone(), ports.clone()),
            ports,
        )
    }

    struct ReplicaPages(Mutex<VecDeque<(Option<String>, crate::replica::ReplicaInventoryPage)>>);
    #[async_trait]
    impl SerializedReplicaExecutor for ReplicaPages {
        async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
            let crate::replica::ReplicaPersistenceRequest::Inventory { cursor } =
                serde_json::from_str(&request).unwrap()
            else {
                panic!("physical census cannot read or write Replica payloads")
            };
            let (expected_cursor, page) = self
                .0
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected Replica page");
            assert_eq!(cursor, expected_cursor);
            Ok(
                serde_json::to_string(&crate::replica::ReplicaPersistenceResponse::InventoryPage(
                    page,
                ))
                .unwrap(),
            )
        }
    }

    #[tokio::test]
    async fn replica_census_scans_all_planned_heads_and_rejects_a_late_foreign_row() {
        use crate::replica::{
            persistence_contract::{prepare_install, reconstruct_snapshot, ReplicaStore},
            ReplicaInventoryFamily, ReplicaInventoryPage,
        };
        for foreign_tail in [false, true] {
            let (unused, ports) = make_runtime();
            drop(unused);
            let mut expected = Vec::new();
            let mut keys = Vec::new();
            for index in 0..130 {
                let account_id = crate::AccountId::from(format!("account-{index:03}"));
                let plan = prepare_install(
                    None,
                    account_id.clone(),
                    format!("user-{index}"),
                    "reserved-generation".into(),
                )
                .unwrap();
                let snapshot = reconstruct_snapshot(&account_id, Some(plan.next_head), vec![])
                    .unwrap()
                    .unwrap();
                keys.extend(snapshot_physical_keys(&snapshot).unwrap());
                expected.push(snapshot);
            }
            keys.sort_by(ReplicaPhysicalKey::physical_cmp);
            if foreign_tail {
                keys.push(ReplicaPhysicalKey::Row {
                    account_id: "unexplained-account".into(),
                    store: ReplicaStore::Operations,
                    record_id: "orphan-operation".into(),
                });
            }
            let source = Arc::new(ReplicaPages(Mutex::new(VecDeque::from([
                (
                    None,
                    ReplicaInventoryPage {
                        version: 1,
                        family: ReplicaInventoryFamily::Replica,
                        entries: keys[..128].to_vec(),
                        continuation: ReplicaInventoryContinuation::More {
                            cursor: "tail".into(),
                        },
                    },
                ),
                (
                    Some("tail".into()),
                    ReplicaInventoryPage {
                        version: 1,
                        family: ReplicaInventoryFamily::Replica,
                        entries: keys[128..].to_vec(),
                        continuation: ReplicaInventoryContinuation::End {},
                    },
                ),
            ]))));
            let runtime = Runtime::with_serialized_executors(source.clone(), ports.clone(), ports);
            let result = replica(&runtime, &expected).await;
            if foreign_tail {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap(), keys);
            }
            assert!(source.0.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn platform_census_reconciles_all_pages_and_shared_area_keys() {
        let (runtime, ports) = make_runtime();
        let mut allowed = (0..130)
            .map(|n| {
                PlatformStorageValue::AccountMetadata(
                    format!("account-{n}").into(),
                    "reserved-incarnation".into(),
                )
            })
            .collect::<Vec<_>>();
        allowed.push(PlatformStorageValue::DeviceKey);
        let mut keys = allowed
            .iter()
            .map(|value| runtime.platform_storage.physical_location(value).unwrap().1)
            .collect::<Vec<_>>();
        keys.sort();
        for area in [Area::DevicePlain, Area::DeviceSecret] {
            ports.0.lock().unwrap().extend([
                (
                    area,
                    None,
                    page(
                        &[Area::DevicePlain, Area::DeviceSecret],
                        keys[..128].to_vec(),
                        Some("tail"),
                    ),
                ),
                (
                    area,
                    Some("tail".into()),
                    page(
                        &[Area::DevicePlain, Area::DeviceSecret],
                        keys[128..].to_vec(),
                        None,
                    ),
                ),
            ]);
        }
        ports.0.lock().unwrap().push_back((
            Area::SessionSecret,
            None,
            page(&[Area::SessionSecret], vec![], None),
        ));
        assert_eq!(platform(&runtime, &allowed).await.unwrap(), allowed);
        assert!(ports.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn native_wrong_area_copy_is_unexplained_even_for_a_planned_key() {
        let (runtime, ports) = make_runtime();
        let key = runtime
            .platform_storage
            .physical_location(&PlatformStorageValue::DeviceKey)
            .unwrap()
            .1;
        ports.0.lock().unwrap().push_back((
            Area::DevicePlain,
            None,
            page(&[Area::DevicePlain], vec![key], None),
        ));
        assert!(platform(&runtime, &[PlatformStorageValue::DeviceKey])
            .await
            .is_err());
    }

    #[tokio::test]
    async fn platform_census_rejects_replayed_keys_cursors_and_topology_changes() {
        for fault in [
            "key-order",
            "cursor",
            "partition",
            "alias-drift",
            "extra-tail",
        ] {
            let (runtime, ports) = make_runtime();
            let allowed = [
                PlatformStorageValue::DeviceCatalog,
                PlatformStorageValue::LocalSecurity,
            ];
            let mut keys = allowed
                .iter()
                .map(|value| runtime.platform_storage.physical_location(value).unwrap().1)
                .collect::<Vec<_>>();
            keys.sort();
            let group = [Area::DevicePlain, Area::DeviceSecret];
            {
                let mut pages = ports.0.lock().unwrap();
                if fault == "alias-drift" {
                    pages.push_back((Area::DevicePlain, None, page(&group, keys.clone(), None)));
                    pages.push_back((Area::DeviceSecret, None, page(&group, vec![], None)));
                } else {
                    pages.push_back((
                        Area::DevicePlain,
                        None,
                        page(&group, vec![keys[0].clone()], Some("tail")),
                    ));
                    let second_key = match fault {
                        "key-order" => keys[0].clone(),
                        "extra-tail" => "bittery:runtime:platform-storage:unexplained".into(),
                        _ => keys[1].clone(),
                    };
                    pages.push_back((
                        Area::DevicePlain,
                        Some("tail".into()),
                        page(
                            if fault == "partition" {
                                &[Area::DevicePlain]
                            } else {
                                &group
                            },
                            vec![second_key],
                            if fault == "cursor" {
                                Some("tail")
                            } else {
                                None
                            },
                        ),
                    ));
                }
            }
            assert!(platform(&runtime, &allowed).await.is_err(), "{fault}");
        }
    }
}
