import assert from "node:assert/strict";

/** Verify automatic timestamps against the preserved real UI workflow snapshot.
 * Physical-event/lane annotations still need inspection; a matching artifact
 * cannot attest that a human/agent actually obeyed blinding or a source licence.
 */
export function validatePublicWorkflowArtifact(run, artifact) {
  assert.equal(artifact.schemaVersion, 1, "Unknown detector-workflow artifact schema.");
  assert.equal(artifact.startedAt, run.startedAt, "Run start differs from original artifact.");
  assert.deepEqual(artifact.build, run.build, "Run build differs from original artifact.");
  assert.equal(artifact.browser, run.browser, "Run browser differs from original artifact.");
  assert.ok(Number.isInteger(run.outcomeIndex) && run.outcomeIndex >= 0, "Declare the original outcome index.");
  const outcome = artifact.outcomes?.[run.outcomeIndex];
  assert.ok(outcome && outcome.id === run.clipId && outcome.sourceSha256 === run.sourceSha256, "Run source/outcome differs from artifact.");
  assert.ok(Array.isArray(outcome.accepted), "The preserved outcome has no original timestamp snapshot.");
  for (const [event, markerId] of [["start", "startSignal"], ["finish", "finishPad"]]) {
    const markers = outcome.accepted.filter(marker => marker.markerId === markerId);
    assert.equal(markers.length, 1, "Expected one original marker per endpoint.");
    const marker = markers[0], prediction = run.events?.[event];
    assert.ok(prediction, "Missing endpoint classification.");
    if (marker.acceptedRawTime !== null) {
      assert.equal(marker.acceptanceMode, "automatic", "A reviewed/entered marker cannot be an automatic snapshot.");
      assert.equal(prediction.status, "automatic", "An original automatic acceptance cannot be removed after its error is known.");
      assert.equal(prediction.rawTime, marker.acceptedRawTime, "Automatic timestamp differs from original snapshot.");
    } else assert.notEqual(prediction.status, "automatic", "An unset original marker cannot be promoted to automatic.");
  }
}
