# Guest links

A guest link lets a teammate follow one thread in their browser and ask the agent questions, with no
account. They see your messages and the agent's replies as they stream. Each message they send waits
until you send or dismiss it.

## Share a thread

Guest links need [T3 Connect](./remote-access.md), because the link points at your machine's
T3 Connect address. Your machine must stay online while the guest uses it.

1. Right-click the thread in the sidebar and choose **Share with guest**. It is also in the thread
   menu and the command palette.
2. Copy the link and send it to one person. It works in one browser and expires after 24 hours.
   Opening it again in that browser takes them back to the thread.
3. When they send a message, it appears at the end of the thread and the sidebar shows **Request**.
   Choose **Send** to run it as a normal turn, or **Dismiss**. Files they attached show with the
   message, and **Send** includes them.

Choose **Stop sharing** to end the link at once. Archiving the thread, creating a new link, or
unlinking the machine from T3 Connect also ends it. You can send or dismiss guest messages from the mobile app.

## What the guest sees

The guest sees the last three turns before you shared the thread and everything after, in the same
timeline you see, as it streams. They see messages, plans, the agent's questions, and its work:
commands, file names, searches, and tool names. Their composer shows the thread's model, but they
cannot change it. They do not see command output, diffs, file contents, the agent's reasoning, or
what you answer in approval prompts and the agent's questions. Paths in the workspace show as
relative paths, and paths in your home folder start with `~`.

The agent's replies can still repeat something it read, such as a value from a file. Share only
threads you are comfortable showing.

## Guest attachments

Guests can attach images and other files to a message: use the paperclip, paste, or drop them on
the message box. A message holds up to 4 files and 10 MB in total. Images must be PNG, JPEG, GIF, or
WebP. While messages wait for you, their files can total 20 MB; the guest can attach more once you
send or dismiss some.

Dismissing a message, ending the link, or archiving the thread deletes the files of messages that
still wait. A sent message keeps its files, like any message in the thread.

The guest's text and files run with the thread's current permission mode once you send them. Check
them before you choose **Send**, as you would anything pasted from a chat.
