import { test as base, expect, type Page } from "@playwright/test";

/** Explicit exercise for authored workflow fixtures, never an event-truth label. */
export async function reviewSyntheticComparisonContext(page: Page) {
  const review = page.locator(".comparison-context-review");
  await expect(review).toContainText("same physical events");
  await expect(review).toContainText("not independent verification");
  await review.locator('input[type="checkbox"]').check();
}

/** Every production workflow must respect the shipped policy and render safely. */
export const test = base.extend({
  context: async ({ context }, use) => {
    const policyViolations: string[] = [];
    const pageErrors: string[] = [];
    context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
    await context.exposeBinding("__climbiqPolicyViolation", (_, description: string) => policyViolations.push(description));
    await context.addInitScript(() => document.addEventListener("securitypolicyviolation", event => {
      void (window as any).__climbiqPolicyViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
    }));
    await use(context);
    expect(policyViolations, "Production Content-Security-Policy violations").toEqual([]);
    expect(pageErrors, "Unhandled application errors").toEqual([]);
  },
});
export { expect };
