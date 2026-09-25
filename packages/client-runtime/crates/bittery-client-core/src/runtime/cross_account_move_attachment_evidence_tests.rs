//! Fixed Attachment effects decide conflicts; unavailable current reads never establish absence.
use super::*;

#[path = "cross_account_move_attachment_authority_tests.rs"]
mod authority_tests;

#[path = "cross_account_move_attachment_resume_tests.rs"]
mod resume_tests;

async fn until(fixture: &RefusalFixture, predicate: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..12 {
        fixture.step().await;
        let record = fixture.record().await;
        if predicate(&record) {
            return record;
        }
    }
    panic!(
        "expected Attachment evidence boundary was not reached: {:?}",
        fixture.record().await
    );
}

async fn permanent_conflict(mode: Refusal, child_count: usize) {
    let fixture = RefusalFixture::new().await;
    fixture.http.set(mode);
    let renewals = fixture.http.renewals();
    let blocked = until(&fixture, |record| {
        record["disposition"]["type"] == "blocked"
    })
    .await;
    assert_eq!(
        blocked["disposition"],
        json!({"type":"blocked", "reason":"missingProof"})
    );
    assert_eq!(
        blocked["stage"],
        json!({"type":"attachments", "nextIndex":0})
    );
    assert_eq!(blocked["children"].as_array().unwrap().len(), child_count);
    assert_eq!(blocked["source"], fixture.accepted["source"]);
    assert_eq!(blocked["target"], fixture.accepted["target"]);
    assert_eq!(blocked["scheduling"]["notBeforeMs"], "0");
    assert_eq!(fixture.http.renewals(), renewals);
    assert_eq!(
        resolution(fixture.runtime(), &fixture.source, &fixture.operation_id),
        OperationResolution::Pending
    );
    assert_source_visible(
        fixture.runtime(),
        &fixture.source,
        ItemProjectionStatus::Pending,
    );
    assert!(fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|request| request.method != "DELETE"));
    assert!(fixture
        .http
        .inner
        .actors
        .http
        .target
        .server
        .attachments
        .lock()
        .unwrap()
        .is_empty());
    if child_count == 2 {
        assert_eq!(blocked["children"][1]["type"], "attachmentRegistration");
        assert!(blocked["children"][1]["result"].is_null());
        assert_eq!(fixture.binary.uploads.load(Ordering::SeqCst), 1);
    } else {
        assert_eq!(fixture.binary.uploads.load(Ordering::SeqCst), 0);
    }
    let owner = checkpoint_owner(&blocked, &fixture.source);
    let generation = publication_generation(&fixture.artifacts, &owner)
        .await
        .unwrap();
    let bytes = stored_ciphertext(&fixture.artifacts, &owner).await.unwrap();
    let calls = fixture.http.calls();
    fixture.clock.advance(86_400_000);
    fixture.http.set(Refusal::Online);
    fixture.step().await;
    assert_eq!(
        fixture.http.calls(),
        calls,
        "an immutable conflict must unschedule this active binding"
    );
    assert_eq!(
        fixture.record().await,
        blocked,
        "passage of time cannot invent a new claim or semantic Item result"
    );
    assert_eq!(
        publication_generation(&fixture.artifacts, &owner)
            .await
            .unwrap(),
        generation
    );
    assert_eq!(
        stored_ciphertext(&fixture.artifacts, &owner).await.unwrap(),
        bytes
    );
    fixture.runtime().close().await;
}

#[tokio::test]
async fn permanent_grant_conflict_keeps_the_original_artifact_and_never_creates_a_new_claim() {
    permanent_conflict(Refusal::GrantConflict { retryable: false }, 1).await;
}

#[tokio::test]
async fn permanent_registration_conflict_keeps_its_unproved_request_without_source_destruction() {
    permanent_conflict(Refusal::RegistrationConflict { retryable: false }, 2).await;
}

async fn lost_registration(unavailable_current: bool) {
    let fixture = RefusalFixture::new().await;
    fixture
        .http
        .set(Refusal::RegistrationConflict { retryable: true });
    let retry = fixture.next_failure(0).await;
    assert_eq!(
        retry["disposition"],
        json!({"type":"waiting", "reason":"offline"})
    );
    assert_eq!(retry["scheduling"]["attemptCount"], "1");
    assert!(retry["children"][1]["result"].is_null());
    assert!(fixture
        .http
        .inner
        .actors
        .http
        .target
        .server
        .attachments
        .lock()
        .unwrap()
        .is_empty());
    let original = retry["children"][1].clone();
    let checkpoint = retry["attachments"].clone();
    let owner = checkpoint_owner(&retry, &fixture.source);
    let generation = publication_generation(&fixture.artifacts, &owner)
        .await
        .unwrap();
    let bytes = stored_ciphertext(&fixture.artifacts, &owner).await.unwrap();
    fixture.before_deadline(&retry).await;
    fixture.http.set(Refusal::RegistrationLost {
        unavailable_current,
    });
    let renewals = fixture.http.renewals();
    let boundary = if unavailable_current {
        let waiting = fixture.next_failure(1).await;
        assert_eq!(
            waiting["disposition"],
            json!({"type":"waiting", "reason":"offline"})
        );
        assert_eq!(
            waiting["children"][1], original,
            "an unavailable GET can establish neither absence nor registration proof"
        );
        assert_eq!(waiting["attachments"], checkpoint);
        assert_eq!(
            fixture
                .http
                .inner
                .actors
                .http
                .target
                .server
                .attachments
                .lock()
                .unwrap()
                .len(),
            1,
            "the retained Server effect must actually exist behind the unavailable current read"
        );
        assert_source_visible(
            fixture.runtime(),
            &fixture.source,
            ItemProjectionStatus::Pending,
        );
        assert!(fixture
            .http
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.method != "DELETE"));
        let grants = fixture.http.matching("/attachment-uploads").len();
        let registrations = fixture.http.matching("/attachments").len();
        let uploads = fixture.binary.uploads.load(Ordering::SeqCst);
        fixture.before_deadline(&waiting).await;
        // The claim may now be consumed/fenced, but matching current metadata must prove the
        // earlier registration without issuing any further grant, PUT, or registration request.
        fixture
            .http
            .set(Refusal::GrantConflict { retryable: false });
        let proved = until(&fixture, |record| {
            !record["children"][1]["result"].is_null()
        })
        .await;
        assert_eq!(fixture.http.matching("/attachment-uploads").len(), grants);
        assert_eq!(fixture.http.matching("/attachments").len(), registrations);
        assert_eq!(fixture.binary.uploads.load(Ordering::SeqCst), uploads);
        proved
    } else {
        until(&fixture, |record| {
            !record["children"][1]["result"].is_null()
        })
        .await
    };
    assert_eq!(
        fixture.http.renewals(),
        renewals,
        "ambiguity/current proof must not invent an authentication refusal"
    );
    assert_eq!(boundary["attachments"], checkpoint);
    assert_eq!(boundary["children"][1]["request"], original["request"]);
    assert_eq!(
        boundary["children"][1]["requestFingerprint"],
        original["requestFingerprint"]
    );
    assert_eq!(boundary["children"][1]["result"]["type"], "verifiedPresent");
    assert_eq!(
        boundary["children"][1]["result"]["attachment"],
        fixture
            .http
            .inner
            .actors
            .http
            .target
            .server
            .attachments
            .lock()
            .unwrap()[0]
    );
    assert_eq!(
        boundary["children"].as_array().unwrap().len(),
        2,
        "registration proof must never occupy the retained Item outcome table"
    );
    let registrations = fixture.http.matching("/attachments");
    assert_eq!(
        registrations.len(),
        2,
        "one retryable refusal followed by one committed but lost registration"
    );
    assert_exact_retry(&registrations[1], &registrations[0]);
    assert_eq!(
        registrations[0].body,
        serde_json::from_value::<Vec<u8>>(original["request"]["body"].clone()).unwrap()
    );
    assert_eq!(fixture.binary.uploads.load(Ordering::SeqCst), 2);
    assert_eq!(
        publication_generation(&fixture.artifacts, &owner)
            .await
            .unwrap(),
        generation
    );
    assert_eq!(
        stored_ciphertext(&fixture.artifacts, &owner).await.unwrap(),
        bytes
    );
    fixture.http.set(Refusal::Online);
    let completed = until(&fixture, |record| record["stage"]["type"] == "completed").await;
    fixture.runtime().close().await;
    assert_eq!(completed["children"][1], boundary["children"][1]);
    assert_eq!(completed["attachments"], checkpoint);
    assert_eq!(
        completed["children"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|child| child["type"] == "itemOperation"
                && child["result"]["result"]["type"] == "applied")
            .count(),
        3
    );
    assert!(fixture
        .http
        .inner
        .actors
        .http
        .source
        .server
        .created_items()
        .is_empty());
}

#[tokio::test]
async fn ambiguous_registration_uses_exact_current_presence_as_its_own_proof() {
    lost_registration(false).await;
}

#[tokio::test]
async fn unavailable_current_after_committed_registration_never_proves_absence_or_replays_its_effect(
) {
    lost_registration(true).await;
}
