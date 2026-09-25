use super::*;

struct BackingGroup {
    areas: Vec<PlatformStorageArea>,
    keys: Vec<String>,
}
impl PlatformStorage {
    async fn reset_inventory(&self) -> Result<Vec<BackingGroup>, RuntimeError> {
        let mut groups: Vec<BackingGroup> = Vec::new();
        for area in [
            PlatformStorageArea::DevicePlain,
            PlatformStorageArea::DeviceSecret,
            PlatformStorageArea::SessionSecret,
        ] {
            let mut cursor = None;
            let mut seen = HashSet::new();
            let mut areas = None;
            let mut keys: Vec<String> = Vec::new();
            loop {
                let page = self.list_keys(area, cursor.clone()).await?;
                if areas
                    .as_ref()
                    .is_some_and(|prior| prior != &page.backing_areas)
                    || groups.iter().any(|prior| {
                        prior
                            .areas
                            .iter()
                            .any(|member| page.backing_areas.contains(member))
                            && prior.areas != page.backing_areas
                    })
                {
                    return Err(platform_storage_invariant(
                        "Profile reset backing areas are inconsistent",
                    ));
                }
                if keys
                    .last()
                    .zip(page.keys.first())
                    .is_some_and(|(last, first)| last.as_bytes() >= first.as_bytes())
                {
                    return Err(platform_storage_invariant(
                        "Profile reset inventory keys do not advance",
                    ));
                }
                areas = Some(page.backing_areas);
                keys.extend(page.keys);
                match page.continuation {
                    PlatformStorageInventoryContinuation::End {} => break,
                    PlatformStorageInventoryContinuation::More { cursor: next } => {
                        if !seen.insert(next.clone()) {
                            return Err(platform_storage_invariant(
                                "Profile reset inventory cursor repeats",
                            ));
                        }
                        cursor = Some(next);
                    }
                }
            }
            let areas = areas.expect("inventory reads a first page");
            if let Some(prior) = groups.iter().find(|prior| prior.areas == areas) {
                if prior.keys != keys {
                    return Err(platform_storage_invariant(
                        "Profile reset aliased inventory changed",
                    ));
                }
            } else {
                groups.push(BackingGroup { areas, keys });
            }
        }
        Ok(groups)
    }

    /// The durable reset catalog remains physically present across every logical-area alias.
    pub(crate) async fn wipe_runtime_namespace_preserving_catalog(
        &self,
    ) -> Result<(), RuntimeError> {
        let catalog = PlatformStorageValue::DeviceCatalog.key()?;
        let groups = self.reset_inventory().await?;
        if !groups.iter().any(|group| {
            group.areas.contains(&PlatformStorageArea::DevicePlain) && group.keys.contains(&catalog)
        }) {
            return Err(platform_storage_invariant(
                "Profile reset catalog is physically absent",
            ));
        }
        for group in &groups {
            self.expect_done(PlatformStorageRequest::DeletePrefix {
                area: group.areas[0],
                prefix: runtime_namespace_prefix(),
                preserve_key: group
                    .areas
                    .contains(&PlatformStorageArea::DevicePlain)
                    .then(|| catalog.clone()),
            })
            .await?;
        }
        let after = self.reset_inventory().await?;
        if after.len() != groups.len()
            || after.iter().zip(&groups).any(|(after, before)| {
                after.areas != before.areas
                    || if after.areas.contains(&PlatformStorageArea::DevicePlain) {
                        after.keys != [catalog.clone()]
                    } else {
                        !after.keys.is_empty()
                    }
            })
        {
            return Err(platform_storage_invariant(
                "Profile reset platform cleanup is incomplete",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, sync::Mutex};
    struct Areas {
        shared: bool,
        inconsistent: bool,
        values: Mutex<Vec<BTreeMap<String, String>>>,
        deletes: Mutex<Vec<(PlatformStorageArea, Option<String>)>>,
    }
    impl Areas {
        fn new(shared: bool, inconsistent: bool) -> Arc<Self> {
            let catalog = PlatformStorageValue::DeviceCatalog.key().unwrap();
            let mut values = vec![BTreeMap::new(); 3];
            for (index, map) in values.iter_mut().enumerate() {
                map.insert(format!("{KEY_PREFIX}:residue-{index}"), "owned".into());
                map.insert(
                    catalog.clone(),
                    if index == 0 {
                        "reset-marker"
                    } else {
                        "misplaced"
                    }
                    .into(),
                );
                map.insert("unrelated".into(), "preserved".into());
            }
            Arc::new(Self {
                shared,
                inconsistent,
                values: Mutex::new(values),
                deletes: Mutex::new(Vec::new()),
            })
        }
        fn index(&self, area: PlatformStorageArea) -> usize {
            match area {
                PlatformStorageArea::DevicePlain => 0,
                PlatformStorageArea::DeviceSecret if self.shared => 0,
                PlatformStorageArea::DeviceSecret => 1,
                PlatformStorageArea::SessionSecret => 2,
            }
        }
    }
    #[async_trait]
    impl SerializedPlatformStorageExecutor for Areas {
        async fn invoke(
            &self,
            input: Zeroizing<String>,
        ) -> Result<Zeroizing<String>, RuntimeError> {
            let request: PlatformStorageRequest = serde_json::from_str(&input).unwrap();
            let response = match &request {
                PlatformStorageRequest::ListKeys {
                    area,
                    prefix,
                    cursor,
                } => {
                    assert!(cursor.is_none());
                    let backing_areas = if self.shared
                        && *area != PlatformStorageArea::SessionSecret
                        && !(self.inconsistent && *area == PlatformStorageArea::DeviceSecret)
                    {
                        vec![
                            PlatformStorageArea::DevicePlain,
                            PlatformStorageArea::DeviceSecret,
                        ]
                    } else {
                        vec![*area]
                    };
                    PlatformStorageResponse::KeysPage(PlatformStorageKeysPage {
                        version: 1,
                        family: PlatformStorageInventoryFamily::PlatformStorage,
                        backing_areas,
                        keys: self.values.lock().unwrap()[self.index(*area)]
                            .keys()
                            .filter(|key| key.starts_with(prefix))
                            .cloned()
                            .collect(),
                        continuation: PlatformStorageInventoryContinuation::End {},
                    })
                }
                PlatformStorageRequest::DeletePrefix {
                    area,
                    prefix,
                    preserve_key,
                } => {
                    self.deletes
                        .lock()
                        .unwrap()
                        .push((*area, preserve_key.clone()));
                    self.values.lock().unwrap()[self.index(*area)].retain(|key, _| {
                        !key.starts_with(prefix) || Some(key) == preserve_key.as_ref()
                    });
                    PlatformStorageResponse::Done
                }
                _ => panic!("unexpected reset storage operation"),
            };
            Ok(Zeroizing::new(serde_json::to_string(&response).unwrap()))
        }
    }
    #[tokio::test]
    async fn inconsistent_reset_aliases_refuse_before_any_prefix_delete() {
        let areas = Areas::new(true, true);
        let storage = PlatformStorage::new(areas.clone());
        assert!(storage
            .wipe_runtime_namespace_preserving_catalog()
            .await
            .is_err());
        assert!(areas.deletes.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn reset_prefix_preserves_catalog_only_in_its_physical_alias_group() {
        for shared in [false, true] {
            let areas = Areas::new(shared, false);
            let storage = PlatformStorage::new(areas.clone());
            storage
                .wipe_runtime_namespace_preserving_catalog()
                .await
                .unwrap();
            let catalog = PlatformStorageValue::DeviceCatalog.key().unwrap();
            let values = areas.values.lock().unwrap();
            assert_eq!(
                values[0].get(&catalog).map(String::as_str),
                Some("reset-marker")
            );
            for index in if shared { vec![2] } else { vec![1, 2] } {
                assert!(!values[index].contains_key(&catalog));
            }
            assert!(values[0].contains_key("unrelated"));
            let deletes = areas.deletes.lock().unwrap();
            assert_eq!(deletes.len(), if shared { 2 } else { 3 });
            assert_eq!(
                deletes
                    .iter()
                    .filter(|(_, preserve)| preserve.is_some())
                    .count(),
                1
            );
        }
    }
}
