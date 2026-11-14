# Decisions

**Decisions** lists everything your agents are waiting on you for: approvals,
questions, and decisions an agent left for later. It covers every thread on every
connected environment, so you can answer them in one place.

## Open Decisions

When a thread is waiting on you, **Decisions** appears at the top of the sidebar
with the number of threads waiting. You can also open it from the command palette
with **Open decisions**, or press `mod+shift+u` on web and desktop when the
terminal is not focused. Customize `decisions.open` in **Settings → Keybindings**.

## Answer from the list

Approve or decline an approval, pick an option or write an answer to a question,
or dismiss a decision you don't want to answer. **Open thread** takes you to the
conversation. Secret and link requests open their thread, where you enter the
value.

## Decisions agents leave

An agent can leave you a decision and keep working. It does this with the
`t3_user_decision` tool instead of writing the question at the end of its reply.
Your answer reaches the agent as a new message. A dismissed decision sends
nothing, and the agent can withdraw a decision that no longer applies.

On mobile, answer approvals, questions, and decisions inside each thread.
