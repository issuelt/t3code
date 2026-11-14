import { describe, expect, it } from "vite-plus/test";

import {
  androidApprovalTask,
  approvalOutcomeText,
  iosApprovalRepost,
  iosApprovalResponse,
} from "./approvalActions";

const pendingApproval = { requestThreadId: "child", requestId: "request", actionable: true };

function iosResponse(
  actionIdentifier: string,
  data: unknown = { environmentId: "env", pendingApproval, deepLink: "/threads/env/thread" },
) {
  return {
    actionIdentifier,
    notification: {
      date: 0,
      request: {
        identifier: "notification-1",
        trigger: { type: "push" },
        content: {
          title: "Refactor billing webhooks",
          body: "Approval: Acme API",
          threadIdentifier: "env/thread",
          data,
        },
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
    expect(iosApprovalResponse(iosResponse("t3.approval.decline"))).toMatchObject({
      notificationIdentifier: "notification-1",
      actionIdentifier: "t3.approval.decline",
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

  it("reposts an unanswered iOS alert with its original content", () => {
    const approval = iosApprovalResponse(iosResponse("t3.approval.accept"));
    expect(approval).not.toBeNull();
    if (approval === null) return;
    expect(
      iosApprovalRepost(approval, { _tag: "Unreachable", environmentLabel: "Workstation" }),
    ).toEqual({
      title: "Refactor billing webhooks",
      body: "Couldn't reach Workstation",
      data: { environmentId: "env", pendingApproval, deepLink: "/threads/env/thread" },
      threadIdentifier: "env/thread",
      categoryIdentifier: "t3.approval",
    });
    expect(iosApprovalRepost(approval, { _tag: "Rejected", reason: "unanswerable" })).toEqual({
      title: "Refactor billing webhooks",
      body: "This approval can no longer be answered.",
      data: { environmentId: "env", pendingApproval, deepLink: "/threads/env/thread" },
      threadIdentifier: "env/thread",
    });
    expect(
      iosApprovalRepost(approval, {
        _tag: "Answered",
        result: { _tag: "Responded", sequence: 1 },
      }),
    ).toBeNull();
  });

  it("tells a rejected answer apart from an unreachable one", () => {
    expect(approvalOutcomeText({ _tag: "Rejected", reason: "not_permitted" })).toBe(
      "This connection cannot respond to approvals.",
    );
    expect(approvalOutcomeText({ _tag: "Unreachable", environmentLabel: null })).toBe(
      "Couldn't reach this environment",
    );
  });
});
