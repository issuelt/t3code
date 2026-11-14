import { describe, expect, it } from "vite-plus/test";

import { androidApprovalTask, iosApprovalResponse } from "./approvalActions";

const pendingApproval = { threadId: "child", requestId: "request", actionable: true };

function iosResponse(
  actionIdentifier: string,
  data: unknown = { environmentId: "env", pendingApproval },
) {
  return {
    actionIdentifier,
    notification: {
      date: 0,
      request: {
        identifier: "notification-1",
        trigger: { type: "push" },
        content: { title: "Refactor billing webhooks", body: "Approval: Acme API", data },
      },
    },
  };
}

describe("approval notification actions", () => {
  it.each([
    ["t3.approval.accept", "accept"],
    ["t3.approval.decline", "decline"],
  ] as const)("decodes the Android task for %s as %s", (actionIdentifier, decision) => {
    expect(
      androidApprovalTask({
        actionIdentifier,
        notificationId: -309004916,
        environmentId: "env",
        threadId: "child",
        requestId: "request",
      }),
    ).toEqual({
      notificationId: -309004916,
      answer: { environmentId: "env", threadId: "child", requestId: "request", decision },
    });
  });

  it.each([
    ["an unknown action", { actionIdentifier: "t3.approval.acceptForSession" }],
    ["a missing request", { requestId: undefined }],
    ["a fractional notification id", { notificationId: 1.5 }],
  ])("rejects an Android task with %s", (_name, override) => {
    expect(
      androidApprovalTask({
        actionIdentifier: "t3.approval.accept",
        notificationId: 1,
        environmentId: "env",
        threadId: "child",
        requestId: "request",
        ...override,
      }),
    ).toBeNull();
  });

  it("answers the request the iOS notification names, on the thread that owns it", () => {
    expect(iosApprovalResponse(iosResponse("t3.approval.decline"))).toEqual({
      notificationIdentifier: "notification-1",
      actionIdentifier: "t3.approval.decline",
      title: "Refactor billing webhooks",
      data: { environmentId: "env", pendingApproval },
      answer: {
        environmentId: "env",
        threadId: "child",
        requestId: "request",
        decision: "decline",
      },
    });
  });

  it.each([
    ["a tap on the notification", iosResponse("expo.modules.notifications.actions.DEFAULT")],
    ["a push without an approval", iosResponse("t3.approval.accept", { environmentId: "env" })],
    ["a response that is not an object", "t3.approval.accept"],
  ])("leaves %s to navigation", (_name, response) => {
    expect(iosApprovalResponse(response)).toBeNull();
  });
});
