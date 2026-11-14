# Home

Home is an agent that works across all of your projects and every machine your
desktop app is connected to. Ask it to start threads, check on them, answer
their questions, approve their requests, rename, settle, snooze or archive them.

## Start Home

Home runs in the desktop app. Open **Settings → Home**, choose a model and turn
it on. Home then sits at the top of the sidebar. Open it from there, from the
command palette, or with its keyboard shortcut.

On mobile, connect to the environment hosted by that desktop, then select
**Home** in the thread list or sidebar. This opens the same conversation.
If several connected environments have Home enabled, each shortcut names its
environment. Keep the desktop app running for access to other machines.

Home always runs in full access. It can approve requests in your other threads,
so choose a model you trust with that.

## What Home does on its own

- Threads Home starts are normal threads in your sidebar. You can open and steer
  them yourself.
- Home links every thread it mentions. Click a link to open that thread, on any
  of your machines.
- Home hears about the threads it started when they finish, fail, ask a question
  or need an approval. The desktop app does not notify you about those threads.
  Home texts you instead: one short line when a thread finishes, and otherwise only
  when something needs you. Ask it for details when you want them.
- Home leaves the threads you started alone. Ask it to watch a thread, or every
  thread, when you want it to step in.
- Home cannot delete threads or projects.

## Fleet board

The Fleet board lists every thread Home started that is not settled or
archived, on every machine this app is connected to, grouped by the job Home
named when it started the thread. Each row shows the thread's status, model and
machine, the last line of its latest reply, and its open pull requests. Click a
row to open the thread.

Open it from Fleet in the sidebar footer, "Open fleet board" in the command
palette, or Mod+Shift+9. These appear once Home has started a thread. Threads
from a machine that is not connected right now are marked Offline and keep
their last known reply. A thread leaves the board when you settle or archive it,
or when auto-settle settles it (Settings → Threads → Auto-settle).

## Other machines

Home reaches your other machines through the desktop app's own connections.
Keep the app running: on macOS, closing the window keeps Home connected until
you quit. When the app is not running, Home can only act on this machine.

On another machine, Home can search threads, clone a repository, and register
or update a project. Cloning needs a connection that may write to source control there.

## Instructions and fresh starts

**Settings → Home → Instructions** opens Home's `AGENTS.md`. Add standing
instructions below T3 Code's section. Home can also keep notes in its folder.

Home never needs compacting. When its conversation fills about half of the
model's context, it continues in a fresh session that carries its recent
messages, and it can read the rest of its thread when it needs to.

**Start fresh** gives Home a new thread with the same model. The old thread
stays in your history, and its notes and instructions carry over.

Turning Home off stops it from acting. Its thread stays in your history.
