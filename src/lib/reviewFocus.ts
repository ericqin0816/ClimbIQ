/** Safari pointer activation does not focus buttons. Capture the review opener
 * before its callback mounts and focuses the review region. */
export function focusReviewOpener(event: { currentTarget: HTMLElement }): void {
  event.currentTarget.focus({ preventScroll: true });
}
