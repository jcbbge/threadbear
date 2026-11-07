# Using Threadbear

<!-- Each `## ` section is also a page on the website, at
     threadbear.mikecann.app/docs/<slug>, named by the slug comment on the
     line under its heading (site/scripts/docs.mjs builds them). The Mac
     app links to some of those pages (site/app-doc-slugs.json lists them),
     so keep a section's slug when you rename its heading. -->

Threadbear is a Mac app for running AI agent threads. It drives the official
Claude Code and Codex command line tools on your own logins. A small program
called the runner keeps every agent going in the background, so quitting or
updating the app never stops a thread. Your threads are also copied to a
Convex deployment of your own, which is how the iPhone app and the website
can follow along.

This guide is for using it. `INSTALL.md` covers setting it up, and `docs/`
has how it all works inside.

## Threads
<!-- slug: threads -->

A thread is one conversation with an agent, working in one folder on your
Mac. You say what you want done, the agent does it (reading files, running
commands, making changes) and replies. You can have as many threads going as
you like, and each one remembers its whole conversation, so you can come
back to it days later and carry on.

### The list

The threads view has four sections. Inbox holds the threads for you, with
the ones that need you at the top. The number on the Threads icon in the
left-hand rail is how many are in it. The arrows at the end of its heading
sort it newest first or oldest first instead, which is handy for working
through a long inbox from the bottom up. ⌥⌘↓ (Go > Next Inbox Thread)
opens the thread below the open one in the Inbox, or the Inbox's first if
the open one is somewhere else; past the last one, a note says you're
caught up. When your threads pass 100, and each thousand after (archived ones
count), a note says so once, the next time you're at the app. Running holds threads whose agent is
working now. A thread that
asks you something keeps its place in the inbox, wake-up or not, and so does
one that has left a job running while it waits for you. Sub-agents are
different: while they're working the thread stays in Running, even if it has
asked you something, as what they find can change what it asks. It comes to
the inbox when they're done, and you can still open it and answer early.
Hibernating and Archived, at the foot, hold the threads that are put away
(see [Hibernate and archive](#hibernate-and-archive)). They start folded,
showing only how many; click a heading to open or fold it. Hibernating also
has the threads that have booked a message to themselves for later (an
agent saying "I'll check again in 20 minutes") and have nothing for you
until then. Each row says when it wakes, soonest first. When the time comes
one of these runs again, and lands in the inbox when it's done.

To keep a thread at the very top, star it: hover its row and press the star,
or use its right-click or ... menu. Starred threads sit in a Starred section
above the Inbox, whatever they're doing, hibernating ones too, in the order you
starred them, so they don't jump around. Archiving one moves it to Archived;
bring it back and it's starred again.

The search box at the top, beside the New thread button, looks through
every thread, the put-away ones too. Type part of a title, or of a thread's
last reply, and each section shows only the threads that match, with folded
ones opened. The x clears it.

### What a row tells you

Each row has the thread's title, with its project under it (or its folder,
when it's in none). Hover that line to see the last thing you said to it.
The tile before the title shows the project too. Your phone's list shows the
same line. A title in bold needs you or has a reply you haven't read.

A thread you didn't start has a small mark before its project: a ladybug
or other tool symbol for a tool such as Sentry, a clock for a schedule, a
pawprint for another thread's agent, books for the librarian. Hover the mark
to see who started it and why.

Before the title, in the gap at the left:

- **A blue dot**: the thread has finished and is waiting on you, with a
  reply you haven't read yet. It stays near the top of the inbox.
- **A tick**: the thread has finished and said there's nothing needed
  from you. It shows until you open the thread, so you can see at a
  glance what got done while you were away.

At the right of the row:

- **Working**, with a spinner and a timer: the agent is busy. In the
  Running section the spinner and timer are enough, so the word is left
  off.
- A grey spinner with something like "2 sub-agents": the turn has ended
  but helpers or jobs it started are still going.
- The blue dot, with an approval card at the end of the thread and no
  grey line: a sub-agent is waiting on your answer. It waits as long as it
  takes, whatever the agent does in the meantime, and carries on when you
  answer. Stop closes the card and stops that sub-agent.
- A time: the thread is idle, or the blue dot on the left says it's
  waiting on you. After a while Threadbear stops an idle
  thread's agent to save memory, and your next message starts it again
  where it left off.
- **Failed**: the last turn ended with an error. Read the thread to see why,
  and send a message to try again.
- **Waiting for connection** (on the Mac and the iPhone): its turn failed
  because your internet went.
  It carries on by itself once the connection is back, so there's no need
  to tell it to continue. A thread cut off mid-turn because the Mac or
  Threadbear restarted carries on by itself too, once it's back up.
- **Stopped**: the runner restarted while the thread was busy.
- **Waiting for room**, with a time: every login it could use has hit its
  limit (see [Accounts, pools and Usage](#accounts)). It carries on by
  itself when one has room again.

### Reading a reply

When an agent finishes a piece of work, its reply is the message it
writes at the end: what it did and what it found. Everything it did to
get there, its notes, thinking, commands and edits, is one line above the
reply, "Worked for 2m 13s": click it to open it. Pictures it made stay
out, as they're often the answer. When the agent carries on by itself
after that (to check its change once the app restarts, say), the
follow-up joins the same line, so there's still one reply to read. When
it picks up again because a sub-agent or a background job finished, a
thin line between its messages says how long it waited and what finished
("6 min later · Mine the repo finished"). When
it needs something from you, a card under the reply asks, and each answer
says what happens if you pick it. If you'd rather have a few short
bullets in place of the agent's message, ask a thread to turn off One
reply (`"oneReply": false` in runner.json). A link with ↑ after it goes
to the step it's about: click
it and the work opens there, with that step lit up. A link to another
thread opens that thread.

An agent can draw a diagram or a small page in its reply: a ```` ```mermaid ````
block shows as the diagram (drawn with [Pele](https://pele.run/), in
Threadbear's colours, light or dark), and an ```` ```html ```` block as the
page, each in a box with the language on the left. Its Diagram / Source
switch (Preview / Source for a page) flips it to the code, the copy button
copies the code, and the arrows open it full size in the side pane. A
diagram that can't be drawn says why above its code. A page is only shown,
never run: its scripts are off, it can't reach the internet or your files,
and it can't open anything, so only its own styles, SVG and `data:`
pictures appear. Your phone draws them the same way, with the arrows
opening it full screen.

Text an agent writes for you to send somewhere else (a Slack message, an
email) comes in a ```` ```slack ````, ```` ```email ```` or
```` ```draft ```` block. It shows in a box the way it'll go out: every
line where the agent put it (the rest of a reply joins single lines up,
as Markdown does), and a Slack draft's `*bold*`, `_italic_`, `~strike~`
and `<url|label>` links drawn as Slack draws them. Copy, at the box's
top right, puts it on the clipboard with its links and bold, so it
pastes into Slack or Mail as it looks. The phone and the website show it
the same way.

A reply that needs nothing from you ends with a Done card at the top of
the message box, with an Archive button to put the thread away. When something it talked about is
still worth doing (a piece it didn't get to, a check that's due), the
card lists them under "Or carry on". Click any of them to tick them
(click again to untick), add anything you like in the message box, and
send: the ticked ones go to the agent together, with your words. Not
sure what one means? Click the ? at its right to ask; it toggles the
same way, so you can ask about several, tick others, and send them all
together. When
the reply does need you, a Needs you card takes its place in the message
box, outlined, listing what to do; the same list is near the top of the
thread's [Highlights](#highlights), with a box to tick off beside each
one. Its heading says what's wanted ("Decisions needed" when every ask
has answers to pick). When there are several asks and they'd take a lot
of room, the card shows one at a time, with ‹ 1 of 3 › by the heading;
picking an answer moves on to the next ask still waiting for one. A long
ask scrolls inside the box, so the reply stays in sight. The chevron at
the card's top right collapses it to its heading, to read the reply behind
it, and brings it back; the next card opens again. Once you reply, the
card goes.

To answer a Needs you card, click its buttons: your picks show on the
card and go with your next message. To answer an ask in your own
words, click Something else under it and write in the box that opens
there. You can paste or drop screenshots in that box too, or use its
picture button, and each goes in where the cursor is as a chip, as in
the composer. Each ask can have a box of its own. Return in a box takes
you on to the next ask that hasn't got an answer yet (a box left empty
doesn't count as one; Shift-Return adds a line), and once they all have one it sends the lot as one message, with
anything you wrote in the message box at the end. Return in an empty
message box does the same with your picks. To send with some left
unanswered, press ⌘Return.

When an ask is about pictures the agent put up to compare, its button can
open that comparison window straight from the card.

The comparison window starts on the first option's first picture. An option
can have several (its overview, how it looks mid-drag, a detail), shown in a
strip under the picture. Next and back (or the left and right arrow keys)
step through every picture of every option, up and down jump to the option
before or after, and after the last one they're all side by side. Click an
option on the right, one of its small pictures, or a dot under the stage, to
go straight to it, and Open live to try one the agent has running (a web
page only). A review from a thread on another Mac opens on that Mac. An
agent can show a video or an HTML page in place of a picture: videos play
quietly on a loop, side by side when they're all showing, with controls
for sound when one is big; a page shows as it does in the side pane, with
its scripts off. When
the agent includes today's version to compare against, hold Space (or click
its button over the picture) to flick to it and back. To look closer at a
picture, scroll or pinch over it to zoom in where the pointer is (a long page
starts small enough to see whole). Then scroll or drag to move around, or use
the small picture in the corner to jump to a part. Pinching out, ⌘0, Esc or a
double-click goes back to the whole thing, and ⌘+ and ⌘- zoom too. Tick as
many as you like, or None if none of them will do, write what you think in
the box at the bottom, and Send takes it all back to the thread.

Inside a thread, rest the pointer on a link for a moment, in a reply or on a
Needs you card's buttons, to see where it goes: a picture of the file, or
the page's address. Click it to open it (the middle mouse button works
too). If an agent already has that page
open in Chrome through [BrowserBear](https://github.com/mikecann/browserbear)
(say, a sign-in page it wants you to use), the click brings the agent's tab
into your Chrome window rather than opening a second one. A link to a file
without its whole path (`shorts-plan/candidates.md`) is looked for from the
thread's folder, as a path in a reply's code is. On the phone and the web,
links to files on the Mac only say so. A link that isn't a web page (one
that would open Slack, System Settings or another app) asks before it opens,
naming the app, on the Mac and the phone, and so does a file that isn't a
plain document (a `.command`, an app, a kind Threadbear can't place).
Another Mac's program never opens here, and its replies never show
pictures from this Mac.

The Browser panel, the globe on a thread's right-hand rail, can show the pages
an agent opens through [BrowserBear](https://github.com/mikecann/browserbear) in
an existing Chrome profile. You can click and type in the same page. The profile's
name and email appear below the address, and its sign-ins stay in Chrome; nothing
is imported. The profile menu opens a new page in the profile you choose, and makes
it the default (starred). An address typed with no page showing opens a new page in
the default profile. BrowserBear
and its extension must be connected to that profile. With no profile to
choose (none connected, or `browserbear agent-only on`), the menu is hidden
and a typed address opens in the agent's own Chrome.

When the agent needs you to do something in a page, handoff opens this thread's
Browser panel with Your turn and Done, even if it was closed. It opens straight
away when you're looking at that thread, or when you next open it; your selected
thread stays yours. The agent waits for Done or the page to settle after your step.
Normal browsing by the agent doesn't open the panel. If Threadbear isn't available
or can't display that tab, handoff opens Chrome's own window instead.
A passkey, a file picker or a password manager's popup belongs
to Chrome itself: press the window button beside the address to use Chrome's
window. Capture and input pause while you use that window; press the button again
to return to the panel. Closing the panel restores the page's normal size.
A page's own alert, confirm or prompt shows over the page under its site's
name ("example.com says"), and what you type in a prompt goes to that site.
A page that opens one after another gets no more than three in ten seconds.

An agent can also use a separate Chrome with `--profile agent`. Its pages show in
the same panel, with its own sign-ins. When that Chrome asks for a passkey or a
permission, its window comes to the middle of your screen and the panel says so,
with Show it to bring it to the front. Existing-profile pages use captured frames,
so movement is less smooth than the separate Chrome's stream.

A link to a folder opens it in the side pane, where it works like a Finder
window. Double-click a folder to go in, or a file to see it there, and the
back arrow takes you back to where you were. Press the space bar for Quick
Look, or use the path along the bottom to go up. ⌘↑ goes up too, and ⌘⇧.
shows hidden files. The button in the bar, or Show as in the right-click menu, swaps the list for
icons, with thumbnails of pictures and videos, and the list sorts by whichever column
you click. It works for folders on your other Macs too, though only this
Mac's files have thumbnails and Quick Look.

Files, the folder on a thread's right-hand rail, opens the thread's own
folder that way, without a link to it. Click it again to close it.

A text file in the side pane opens for reading. The pencil in its bar
switches to the raw text for editing, with line numbers down the side.
What you type is saved a moment after you stop, and ⌘S saves it straight
away. If the file changes on disk while you have unsaved edits (an agent
rewrote it), nothing is written over: a bar asks whether to take the
file's version or keep yours.

An HTML file opens in the side pane as a static page, with the styles,
pictures, fonts and media beside it that its markup names. Script files,
SVGs and other pages beside it don't load, so a mockup made of several
HTML or JS files shows only its main page. It's kept off the internet
too, so a font or picture from the web is left out, and its links don't
open. A page with scripts of its own opens with them off and a bar over
it: Run them turns them on for that page, still kept off the internet,
until the file changes, when it asks again. Open the file in your
browser to see it with everything.

To share a file somewhere else, drag it out of the app: a file link in a
reply, a picture in the transcript, a file in Highlights, a row in a folder
in the side pane, or the picture or video showing there. It drops as the file itself, so you can
drag a clip straight into a post on X, or onto the Finder. A web link drags
out as its address.
To paste a picture instead, right-click it in the side pane and choose
Copy Image.

## Full access or Ask before edits
<!-- slug: full-access -->

Read this before your first thread. Every thread runs in one of four modes,
shown on the composer (the box you type in) and changed by clicking it.

- **Full access** (the default): the agent edits files and runs commands
  without asking. It can do anything your Mac user account can do, in any
  folder, including deleting files. This is how Threadbear is meant to be
  used day to day, and it's fine for a folder you trust it with.
- **Ask before edits**: the agent stops for your OK before it edits a file
  or runs a command. A card shows in the thread with Allow, Always allow and
  Deny. Always allow only lasts for that thread. A Codex thread in this mode
  can read files but not change them unless you agree. It also asks before
  it does anything to Threadbear itself: messaging or starting another
  thread, changing this one, schedules, projects, pins, panels and the
  Pocket. Reading threads, asking you for a secret and ending its turn
  never ask.
- **Auto** (Claude threads only): a separate safety check approves or blocks
  each action, and a card shows only when it can't decide. It's for work on
  text you didn't write, like an error report or a web page. It catches a lot
  but it's no guarantee, and on a Codex thread it behaves like Ask before edits.
- **Plan first**: the agent looks around and writes a plan, but changes
  nothing yet. The plan shows as a card with Go ahead and Send back. Go
  ahead (or Return in an empty message box) lets it start, back in the mode
  the thread had before. Send back, or just writing what you'd change, has
  it plan again. Once it's working, the same card ticks off its steps.

In Ask before edits and Auto, an edit to a file Threadbear runs by itself
(a patch, a file a patch uses, or Claude Code's settings) always asks, with
no Always allow, and the card says Threadbear runs the file as code. If a
patch runs something Threadbear can't follow, every edit asks, and the card
says it can't tell whether the file runs as code. Even once you allow it, the
patch waits for you to trust it in Patches.

The mode belongs to one thread. A new thread starts on Full access again
unless you pick otherwise, so if you're unsure about a task, switch it to Ask
before edits before you send. Deleting a thread is one thing an agent always
has to ask about, whatever the mode.

An agent in Ask before edits or Auto can't give itself more room. Switching
any thread or schedule to more access, starting a thread with more access
than its own (the threads it starts get its mode), messaging or moving a
thread that has more, changing the brief of a project such a thread is in,
or adding a schedule check all show a card for that one call, with
no Always allow. The card shows the whole message or brief, and the
folder where it really is. On a Codex thread, Always allow on a command allows that
exact command again in that folder, not anything that starts the same way,
and it's only offered for simple commands like `ls` or `grep`: one that
runs the repo's own code (`npm test`, `make`, `cargo run`) asks every
time, as the repo can change what it runs.

A card shows the whole command. On the phone, one that's too long to read
there in full (or one asking for more access) has only Deny: allow it in
the Mac app.

### When an agent needs a password or a key

An agent that needs a secret (your Mac's administrator password for a
`sudo` command, an API key, a token) asks for it in a card in the thread
instead of in its reply. Type it into the card and click Save securely, or
Decline. You can answer it on your phone too, where it's sealed so only your
Mac can read it on the way through. The phone only sends secrets to Macs
it learned about from a pairing code, so if it says it doesn't know this
Mac yet, answer on the Mac, or pair the phone again from the code in that
Mac's Settings > Phone & browser.

It never goes into the chat: the agent gets a private file holding it,
which its commands can read for 24 hours, and then it's deleted. That's
not the same as hiding it from the agent. A command that prints the file
would put it in the transcript, so only give a secret to a thread you'd
trust with it.

If a key does end up in a thread's words, Threadbear takes out what it can
recognise before the text reaches your phone or the website, which show
`[REDACTED]` there; the Mac keeps every word. It goes by the shapes keys
usually have and the values in your `.env` files, so it won't catch
everything, and it can't read pictures. Treat a key that showed up in a
thread as leaked and replace it, since the AI provider has seen it too.
`tb status` says what this runner does.

## Your first thread
<!-- slug: first-thread -->

Press ⌘N, or click New thread (the pencil beside the search at the top of
the list), type a message and press Return.

New threads start in the `ThreadbearThreads` folder in your home folder
(`~/ThreadbearThreads`), which setup makes for you. You can pick another folder for
one thread from the composer's + menu, or change the default in Settings
(⌘,).

A safe first message is one that only reads, such as "What's in this
folder?" or "Explain what you can do for me here." When you're ready for it
to make something, try "Make a file called hello.txt that says hi" and watch
it appear in `~/ThreadbearThreads`.

Return sends and Shift-Return adds a new line. In a list, Shift-Return
starts the next item ("2. " after "1. milk", "- " after "- milk"), and
Shift-Return on an empty item ends the list. You can paste or drop images
into the composer, or add them with +. Each one goes in where the cursor
is (or where you drop it) as a small chip, "Picture 1", "Picture 2", with
its thumbnail, and the agent gets each picture right there in your words.
You can let go of a file anywhere over the thread, not just on the box: the
thread's outlined while it'll take it, and the file goes in where the cursor is.
So "this one [Picture 1] should look like this one [Picture 2]" says which
is which. The thumbnails show over the text too; the cross on one takes it
and its chip out. Hover a chip to see its picture, in the composer or once
it's sent; in the thread, clicking one opens the picture in Quick Look.
Any other file you paste or drop in (a video, a PDF, a folder) goes in as
its full path where you drop it, for the agent to open where it is.
Nothing's copied, so a big one is fine.

Paste a thread's id (Copy thread id in its ... menu or its right-click
menu in the sidebar), or drag its row from the sidebar onto the open
thread, and it goes in as a chip with that thread's title. Dragging a row
left still archives it; any other way drags the thread. The agent gets a `thread:<id>` link it can
read the thread from, and clicking the chip once it's sent opens that
thread. An id that isn't one of your threads pastes as plain text.
Stop (⌘.) ends a turn that's running.

A message shows in the thread as soon as you send it, faded, with a
spinner beside it until the runner has it (a busy Mac can hold the runner
up for a few seconds). A clock instead means it's waiting for the turn
that's running to finish, and it starts its own turn then. If it can't be
sent, it goes and its text is back in the composer. Starting a new thread
keeps your message in the composer, greyed, with a spinner in place of
Send, until the thread exists.

### Going back to an earlier message

Hover over one of your own messages and click the pencil to change it. Its
text goes into the composer; send it and the thread goes back to that
point. The agent forgets that message and everything after it, the
changes it made to files since then are put back, and your new version is
sent as if the rest had never happened. A turn that's running is stopped
first. What was cut is gone from the thread, and a line where it was says
how many files were put back.

Going back stops anything the agent left running in the background (an
upload, a long build), even if it started it before the message you're
changing. When something is, the app asks first and says what: Cancel
keeps it running, and you can send your change as a new message instead.

Files changed by commands the agent ran (a script, `git`, `npm install`)
aren't put back, only ones it edited or wrote itself. If you've changed one
of its files yourself since, that file may be left as it is, and the line
says so. A message you sent while the agent was working went into that
turn, so edit the message that started it instead.

### Slash commands

A message that starts with a command, like `/compact`, runs it rather
than going to the agent as words. In a Claude thread Claude Code runs its
own commands and your skills (`/compact`, `/context`, `/cost`, `/clear`,
`/code-review`). A Codex thread runs `/compact`, `/review` (the
uncommitted changes, or what you write after it), `/clear` or `/new`,
`/status`, and `/` with the name of one of your Codex skills.

Two are Threadbear's own, on both: `/model` and `/effort` change the
thread's model and effort level, the same as the menus under the message
box, so the change sticks. On their own they say what the thread is on and
what you can pick. `/clear` starts the agent on a fresh session; the
transcript above stays for you to read.

Type `/` in a thread's message box and a palette opens above it with
every command the thread can run: Threadbear's, the CLI's and your
skills, with Recent for the ones you picked lately. What you type narrows
it, and the one picked is described on the right: how to use it, its
other names, what `/model` and `/effort` are set to now, and where it
comes from (yours, this folder's, a plugin's) with its file and an Open
button that shows the file beside the thread.
Up and Down move, Return runs it, Tab puts it in the box so you can type
its details after it, and Esc closes the palette. Clicking a category
shows only those; double-clicking a command runs it.
Drag the palette's top edge or sides to make it bigger or smaller (the
border lights up where it will drag), as wide as the window, and the
lines between its columns to size them. It keeps the sizes for next
time. Right-click it for its default size or column widths, or
double-click a line to put that column back.

A command waits for a running turn to finish rather than going into it.
Commands that only make sense in a CLI's terminal (`/resume`, `/rewind`,
`/login`) get a line saying how to do that here. Anything else starting
with a slash, such as a file path, goes to the agent as words.

## Hibernate and archive
<!-- slug: hibernate-and-archive -->

To put a thread away for a while, hibernate it: hover its row and press
the moon, or use the Thread menu or the ... menu. Pick when it should
come back: in an hour, this evening, tomorrow, next Monday, or a day on a calendar and a
time of your own. It leaves the list, its agent stops, and it comes back marked unread
when the time comes. Its row says Woke up until you open it, and the
thread says how long it was away, beside a bear that's only just got up. Hibernating threads wait in the Hibernating section at
the foot of the list, soonest to wake first. Hibernate the thread you have
open and its page sinks into the moon on that heading as the next thread
comes in.

Or pick Wake when… and say it in your own words: "at the weekend", "in a
few weeks", "next time I talk about woodworking". Opus works out what you
meant (the row says Thinking… for a few seconds) and the thread says what
it settled on. A topic waits for you to bring it up: when the librarian
sees you talking about it in another thread, it wakes this one and says
where.

When a thread is done, archive it: press ⌘E, hover its row and press the
box, or swipe the row left with two fingers on the trackpad (or drag it
left with the mouse) and let go once the space behind it turns blue (a
quick flick works too). However it's archived (⌘E, a button, or an agent
or your phone doing it), its row slides off the same way. Archive the
thread you have open and its page drops into the Archived heading as the
next thread comes in. If it was the last one, the bear comes up over the
new thread page and waves. When you archive one, a note saying so floats at
the top of the thread panel for a few seconds (longer while the pointer's
on it): Undo puts the thread back, and a click anywhere else on it opens
the thread. The Archived section at the foot of the list has
them, most recently archived first, with the older ones behind Show more
(the search at the top finds any of them). Unarchive, or the same swipe
there, puts one back.

Back and Forward (⌘[ and ⌘], in the Go menu) step through the threads and
pages you've had open, as a browser does. A mouse's side buttons do the same,
and so does a trackpad swipe, as in Safari: right for Back, left for Forward,
with an arrow at the window's edge that follows your fingers and turns blue
once letting go will go. A swipe that starts mostly up or down is a scroll, so
a long thread still scrolls. It
follows Swipe between pages in System Settings > Trackpad (two or three
fingers). Over a thread's row a swipe left still archives it.

Hibernating or archiving a thread that's partway through a turn stops
that turn. From the row's hover buttons, Threadbear asks first.

You can also ask a thread to do it to itself ("hibernate this until
Thursday", "archive this when you're done"). It finishes its reply first,
then goes, with a note in the thread saying when it'll be back. A time
works, or words like "until the phone arrives", read the same way as Wake
when…. It won't put itself away while it's waiting on you. A thread
whose next step waits on other threads hibernates by itself until they
finish, then wakes with what they said and carries on; its row says
Waiting on and which. It can also say what it's waiting for a thread to
do ("until it reports the I/O saving"), and then the librarian reads
that thread after each of its turns and wakes it once it has. On the
iPhone and the website a hibernating row starts "Until …" when it waits
for more than a time. A thread can also hibernate until the runner
updates to a new release (a restart on the same one leaves it asleep). One waiting on a job that will message it does the
same until the message comes. Either way it has a time it comes back
anyway, a day unless it says otherwise.

## Panels
<!-- slug: panels -->

The window is made of panels you can move around: the list of threads,
the thread you're reading, Highlights, a project's panels, Patches, and
the ones you open from the left-hand rail, such as Usage and Updates. Each
panel has a bar along its top with its title, and panels that share a
space show as tabs in it. To begin with there are three side by side:
the list, the thread and Highlights.

To move a panel, press and hold on it for a moment, then drag. That works
anywhere on the panel: its title, one of its tabs, the empty part of its
bar or its background. On a title or tab a plain drag works too. A quick drag on the empty part of a
bar moves the whole window instead, as there's no title bar, and a
double-click there zooms it. While you drag, the panel shrinks under the
pointer and shows where it will go when you let go:

- Over another panel's bar, a tab with its name shows there: let go to
  add it as a tab.
- Near one side of another panel, that side lights up: let go to split
  that panel's space in half.
- In the middle of another panel, a compass shows. Drop on one of its
  arrows to dock above, below, left or right of it, in the middle to add
  it as a tab, on Swap to change places, or on Window to give it a
  window of its own.
- Along the window's own edge, it docks across that whole side.
- Past the edge of the window, it opens in a window of its own. Right-click
  a panel's title for Open in New Window too, and Put Back in Main Window
  to bring it home.

Escape, or letting go anywhere else, puts it back where it was. Drag the
line between two panels to resize them, and click × on a tab to close it.
Right-click a title for Hide Title, which leaves the panel without a bar
while it's on its own; a thin strip along its top still lets you drag it.

The icons down the right edge of the window open and close the thread's
own panels: Highlights at the top, one for each panel its patches add,
and Patches at the foot. To open a thread in a panel of its own, beside
the one you're reading, right-click it in the list and pick Open in New
Panel.

The View menu has the rest: Show or Hide Threads (⌃⌘S) for the list,
Show or Hide Panels (⌥⌘P) for the panels beside the thread, and Reset
Panel Layout, which puts everything back how it started. Threadbear remembers your
layout between launches.

## Highlights
<!-- slug: highlights -->

Highlights is the panel beside the thread that collects what the thread
has made and shared, so you can find it without scrolling back through
the conversation. It fills in by itself as the agent works. Its icon is
the pin at the top of the right-hand edge, which gets a dot while the
last reply has things for you to do.

From the top, and only when there's something to show:

- A line or two from the librarian on where the thread is up to.
- **Needs you**: what the agent's last reply asked you to do, each with a
  box to tick off as you go. Ticking one here ticks it in the thread too.
- The thread's projects, each under its icon and name with its links,
  such as a live site or an admin page, and its task board if it has one
  (see [Projects](#projects)). The ⓘ beside a project's name
  says who put the thread there and why ("Shortlists photos for the
  calendar entry"). If the librarian guessed wrong, press Take out there
  and it won't put it back; Keep stops it ever taking the thread out.
  The librarian also renames a project whose name has gone out of date
  (a tool it's about was renamed, say), but never one you named or
  renamed yourself.
- **Scheduled**: messages booked to come to this thread. Click one to
  change it.
- **Sub-agents**: helpers the agent started, with how each is getting on.
  Click one to read what it did.
- **Threads it started**: other threads its agent started, and any it's
  waiting on, each with where it's up to: the ones that need you first,
  then failed, working, hibernating, done and archived. Click one to open
  it. Their questions still come to your inbox like any thread's.
- **Pinned**: what the agent pinned for you (below).
- **Files**: documents, pages, pictures and videos the thread wrote, opened
  or mentioned.
- **Links**: web pages and pull requests it opened or mentioned.
- **Changes**: its commits, and a line such as "4 files edited" that
  opens to the code it changed.

Click a heading to fold that section away, and again to bring it back. A
folded heading shows how many rows it's hiding. Threadbear remembers what
you've folded, between launches and for every thread: fold Sub-agents once
and it stays folded everywhere. A project's heading folds for that project.

Click a file and it opens in the panel, with Back to return to the list
(a text file there has Edit too). A link opens in your browser, unless you
change Default in its right-click menu to open pages in the panel. An
edited code file opens in its own app, and a Tandem project opens in
Tandem, here and in a reply. Right-click any of them for more,
such as Reveal in Finder, or Remove to take it off the list. You can drag
files out of Highlights into other apps.

### Pins

An agent can pin a file or link to Highlights, under Pinned, with its
`pin` tool and a short note on why you should look at it: a mockup it
made for you to check, a preview address, a pull request. It can also
open the pin straight away, in the panel beside the thread. Files it
writes and links it mentions show up by themselves, so pins are for the
few things that matter most. To have something pinned, ask the thread
("pin the mockup for me").

## Projects
<!-- slug: projects -->

A project gathers the threads about one thing, whatever folder they ran
in: an app you're building, a trip, a house move. Each has goals, a few
lines on where it's up to, notes for later threads (decisions and
gotchas), links (its live site, an admin page) and folders, the repos its
work lives in. The Projects view lists them, with New project at the top;
click one for its page, with its threads, state and notes. The search at
the top of the Projects page looks through their names, state, goals, notes
and folders: Return opens the top result and Escape clears it.

A thread gets into a project in one of three ways: the librarian files it
(below), its agent joins one, or you put it there, from Projects in its
right-click menu. A thread can be in more than one. Its agent is told a
little about each project it's in, and gets the panels and Patches from
the projects' folders. If one is wrong, Take out in its Highlights keeps
it out for good.

A project can show a task board from Notion. Give it a Notion page with a
Tasks database on it (a board grouped by Status): Add Notion page… under
Tasks on its page, Notion Page… when you right-click it in Projects, or ask
an agent to. The page shows the board, read every few minutes, with a
column per status and who and when on each card. Cards are moved in Notion,
by you, anyone you share the page with, or the agents, who see the open
cards and are told to keep them moving. A card whose Thread column names a
thread links to it. A thread's Highlights shows each of its projects' boards too, under the
project: what's under way first, then what's to do, with Done folded to a
strip you can click open. If the columns don't fit, drag the bar under them,
use its arrows, or scroll sideways, or drag the panel wider. Click a card to
mention it in your message: it shows as a chip with the card's title, and the
agent gets a link it can read the card from. Click the chip in a sent message
to open the card; the arrow
on a card, or its right-click menu, opens it in Notion. Boards are read through
a Connectors gateway (see [Connectors](#connectors)); without one, the
project's page says so and nothing is read.

## The librarian
<!-- slug: librarian -->

The librarian reads your threads as they go and keeps your projects tidy.
It files each thread in a project, making one when none fits, keeps each
project's state up to date, adds a repo to a project's folders once its
threads work there, and renames threads that have wandered off from their
title (never one you named). It also looks after the Pocket cards threads
filed. Its picture, and the one on the Scheduled page, say something if you
poke them.

It looks after a thread's first message and when a turn ends, then catches
up at most every 20 minutes while the thread keeps going. A catch-up after
only a quick reply is skipped without asking anything.

Each look is one short call to Haiku, Claude's small, cheap model, rather
than the model your threads run on. It runs on one of your own Claude
logins: the one the pool would pick next in the pool chosen under Runs on (the
same pool that writes thread titles, also in Settings › Models), and it
counts towards that login's usage like any other call. When every login in
the pool is out of room it waits, and with only Codex logins it doesn't
run at all. Threads in a private folder (Settings › Models) are never sent
to it.

The Librarian view lists what it did and what it will look at next. Turn
off Look at threads there to pause it; what's queued waits until you turn
it back on. If it files a thread wrongly, take the thread out of the
project and it won't put it back.

## Schedules
<!-- slug: schedules -->

A schedule sends a message at a set time, once or over and over: to a
thread, or to a new thread each time (a morning summary, say). Make one in
the Scheduled view (⌘2), or ask an agent ("look at this again every weekday
at 9"). The Scheduled view lists them under Active, Paused and Done, with
when each runs next. One that starts a new thread each time keeps the
pool the composer was on when you made it, so each run starts on
whichever of that pool's logins it would pick then; ask an agent to put
it on another pool or one login. Click a heading to fold it away (Done starts folded); a
folded one shows how many are under it. Its page
says what's coming up next with a few numbers: how many are on, due in the
next day, repeating, set by threads, paused, and how often they've run.

A schedule's message brings an archived thread out of the archive while it
runs. If the run ends with nothing for you, the thread goes back into the
archive, so a watcher you've put away only lands in your inbox when it has
something you need to act on.

If you run Threadbear on more than one Mac (or on a Linux server as well,
INSTALL.md section 6), a schedule that starts a new
thread can run on any of them: pick the Mac under Runs on. It runs there
even while this one is asleep, in that Mac's folder (leave the folder
empty for its default). Its threads show on your phone and the website, and
threads made on another Mac show in your sidebar too, with that Mac's
icon in the row. Open one and this Mac reads it from your Convex backend
and sends what you do there (messages, approvals, Stop, archive) for that
Mac to pick up, the way your phone does, so there's no network link between
the two Macs to set up. You see its messages and a line for each tool it
used; the tool output, diffs and pictures stay on that Mac for now, and a
tool row says so. Pictures you paste or drop in your message go with it
(up to 6, 25 MB each), through your Convex storage, which keeps them only
until that Mac has fetched them. Editing a message, its highlights and patches, and
changing its login or model are done on that Mac. Agents see them the
same way: `list_threads` lists and searches them (each row says which Mac),
`read_thread` reads them, `send_message` messages them, and they can stop,
snooze or archive them. A Mac that's off shows
its threads but can't take a message until it's back. Its archived
threads are in your Archived list with the rest, to reopen or unarchive.
Settings > Runners > Connect to other machines directly opens them over
Tailscale instead, with
everything, as before: that needs that Mac to be on and its key and host
copied to this one (run `tb pair` on that Mac and it prints the two files
to make here and how). To add a Mac, give it a key of its own from this one: `tb runner
add <name> --ssh <that Mac>` writes it there, and its runner uses it from
its next restart. Set that Mac up with `./threadbear setup --existing`, which
leaves out the Convex login and deploy key (either could do anything to your
backend) and ends by telling you to run that command; `tb runner check` there
says if an older setup left them behind.
That key only reaches its own Mac's threads, schedules and Pocket cards: it
can't pair a phone or put a schedule on another Mac, and that Mac's app
doesn't list the other Macs' threads. Only the first Mac's key can. A new
thread from your phone goes to your first Mac, and waits for it while it's
asleep, unless you pick another Mac for it. Notifications from another
Mac's threads start with that Mac's name. After moving a Mac onto its own
key, `tb runner rotate-owner` on your first Mac changes the main key (it
won't while another runner it has seen lately is still on the main key:
it names each one with the `tb runner add` that gives it its own, or
`--lock-out` cuts it off on purpose), and
`tb runner audit` lists the phone tokens, schedules, cards and messages the
old one could have made, to take out any you don't recognise.
An agent on one of those other Macs can still ask for a thread on this
one (to try something only your Mac can, say): a card in its thread shows
who's asking, the folder, its access and the whole brief, and Start it
starts it here, from this Mac. Answer it in the Mac app; the phone shows it
but can't start it. The new thread is told which thread asked, and can
message it back. Agents on this Mac start threads on the other Macs
without asking.
With the direct link on, its pictures and files come from that Mac as you open them. To start a
thread on another Mac, pick it with the machine chip on the composer: the
folder, account and model are then that Mac's. New threads start on the
starred one: change it under Default in that chip's menu, or in
Settings > Runners, which also lists your runners and whether they're
online, in your order: drag one to change it. The
phone has the same order, and a new thread from it starts on the first
runner that's online in it. Adding, renaming or pairing a runner is done on its own machine,
so ask an agent to do it for you. Schedules need your
Convex backend: with no internet, they wait.

With more than one runner, Runners (the rack icon near the bottom of the
left-hand rail) opens a panel with each one: whether it's online and for
how long, or when it was last heard from, the commit it runs, and the
threads running there, which open with a click. A grey dot on the icon
means one is offline or updating. Click a runner's name to see its CPU,
memory and disk, what machine it is and how long that machine has been
up. A bar turns orange when memory is 90% used or disk is under 10 GB free.
The figures come every 10 seconds while the details are open and the
window can be seen; a runner too old to send them says so.

## Accounts, pools and Usage
<!-- slug: accounts -->

Threadbear uses the Claude Code and Codex logins already on your Mac: the
Claude Code login in `~/.claude` and the Codex login in `~/.codex`. It never
reads their passwords or tokens. The account and model a thread runs on are
small menus on the composer. Whatever you picked last is what the next
thread starts on.

Once a thread has run a turn, a small ring beside the send button shows
how full its context is: how much of the model's window the conversation
takes up. It turns orange when it's nearly full, as Claude and Codex
compact the conversation by themselves soon after. Click it for the
tokens used out of the window, the model and login the thread really ran
on, and what it has cost so far.

To add another login, such as a second Claude subscription, give it a
folder of its own under `accounts` in Threadbear's data folder, named
`claude-1` (then `claude-2` and so on, or `codex-1` for Codex), and sign in
there in Terminal:

```
CLAUDE_CONFIG_DIR=~/Library/Application\ Support/Threadbear/accounts/claude-1 claude
```

then type `/login` (for Codex, `CODEX_HOME=<the folder> codex login`). It
shows up in the account menu within a few seconds.

If a login stops working (you signed out, or its session ran out and
couldn't be refreshed), the thread's turn fails and a line above its
messages says so. Sign in… opens Terminal on that login's own sign-in, and
Send again sends your last message again once you're done. For a thread on
another Mac the line says which Mac to sign in on, as Terminal here would
only sign in this Mac.

If Claude stops with a safeguards refusal, a small box above the message
field offers **Continue with Codex Sol**, when Sol is available on a Codex
login with room. Clicking it moves this thread to GPT-6.1-Sol and asks it
to continue, with the conversation carried across. It pins the thread to
that Codex login. Anything you've typed in the message field stays there.
The switch happens only when you click.

Titles, the librarian and Wake when… run on a Claude login, so with only
Codex they don't happen: threads keep the first line of their first message
as their title.

Logins are grouped into pools, one for Claude and one for Codex to begin
with (Settings > Pools). A new thread in a pool starts on the login with room whose
weekly limit resets soonest, so a week's leftover gets spent before it's
lost rather than draining the login with the most room. When the one it's on gets close to its limit, it moves to
another login in the pool with room, and carries on from where it was. When
none has room, the thread waits and carries on by itself once a limit
resets. With only one login, that means it waits for that login's limit to
reset.
The first time a pool has a second login, a card by the composer says
what pools do.

With more than one machine, they all share the same pools, so you set them
up once from Settings > Pools on any of them. A pool knows its logins by
email, and each machine uses the ones it's signed in to: a pool of three
Claude logins is just one on a server signed in to one of them, and a pool
none of its logins are in doesn't show there. A login signed in on several
machines is one subscription, so each machine shows the newest reading of
its room from your first Mac, and one that hit its limit there waits on
the others too. A Mac with a key of its own gets your first Mac's readings of only the
logins you list for it there: `tb runner logins` shows each one's list
beside the logins it says it has, and `tb runner logins <runnerId>
claude:you@example.com` sets it. Your first Mac goes by its own readings,
never that Mac's.

Usage, the honey pot near the bottom of the left-hand rail (it's filled to the
room left on the login your next new thread would use), shows how much room each login
has left before it hits its limits: the weekly one, and the 5-hour one for
logins that still have it (Claude Team does, Max plans don't any more).
Threadbear learns these numbers from the threads it runs, so a login's bars
fill in once it has run something.

At the top it shows what you've spent: tokens today (and what a usual day
had spent by this time), in the last hour and over the last 7 days, with a
chart by the hour or by the day, each login in its own colour. Hover a bar
to see who spent what. The tokens are read from the Claude and Codex
transcripts on your Mac, so work done outside Threadbear counts too; the
first read takes a minute or so after the runner updates.

Below that, each pool is a card, with each login in it: what it's spent
today, and its weekly window (plus the 5-hour one where the login has it).
The weekly one has a small chart
of the week so far, with your current pace dashed on to the reset. Under
each window is what that pace means: in orange, when it runs out and how
long before the reset; in green, how much of the week will go unused, so
it's worth leaning on that login; otherwise that it's on track, or when it
resets. Hover a window for its rate.

A Claude login with a limit of its own on Fable shows that week too,
"Weekly Fable", with its own chart beside the others, as Claude Code's
`/usage` does. Running out of it only stops Fable: the login can still run
other models, so it never makes a login look full.

Claude threads run through Claude Code's Agent SDK, and Anthropic's 5-hour
meter seems to count that traffic as more per token than the same work typed
into `claude` in a terminal. People have measured anywhere from about 1.6 to
2.9 times as much ([anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074)),
while weekly limits come out about the same in most of their tests. Some apps
change the label the SDK sends to get around it. Threadbear leaves the label
as it is for now.

## Keyboard shortcuts
<!-- slug: keyboard -->

Hold ⌘ to see the keys beside the buttons that have them. Settings (⌘,) >
Keyboard lists every command in the menus that can have a key, and you can
change any of them there. Click a command's key and press the new one. Esc
cancels, and Delete removes the key. A command with no key has an Add button,
and one you've changed has Reset beside it.

A key has to include ⌘ or ⌃, or be a function key, otherwise it would type
instead. If another command already has the key, it asks whether to give it to
this one, which leaves the other with no key. Keys that something else needs,
like ⌘C for Copy or ⌘← for moving the cursor, can't be used.

The keys you've changed are in `shortcuts.json` in Threadbear's data folder, so
you can ask an agent to change them too, and a change to the file shows straight
away. It holds only what you've changed, by the names below, and `null` means no
key:

```
{
  "nextInboxThread": "ctrl+j",
  "archive": null
}
```

- New Thread: `newThread`, ⌘N
- Archive: `archive`, ⌘E
- Hibernate (opens Pick a time): `hibernate`, no key
- Stop: `stop`, ⌘.
- Copy Transcript as Markdown: `copyTranscript`, ⇧⌘C
- Back: `back`, ⌘[
- Forward: `forward`, ⌘]
- Next Inbox Thread: `nextInboxThread`, ⌥⌘↓
- Show Inbox: `showInbox`, ⌘1
- Show Scheduled: `showScheduled`, ⌘2
- Show Projects: `showProjects`, ⌘3
- Show Librarian: `showLibrarian`, ⌘4
- Show Hibernating: `showHibernating`, no key
- Show Archived: `showArchived`, no key
- Settings: `settings`, ⌘,
- Zoom In: `zoomIn`, ⌘=
- Zoom Out: `zoomOut`, ⌘-
- Actual Size: `actualSize`, ⌘0
- Show Threads: `toggleThreads`, ⌃⌘S
- Show Panels: `togglePanels`, ⌥⌘P
- Reset Panel Layout: `resetPanelLayout`, no key

In the file, a key is its modifiers and then the key, joined with `+`: `cmd`,
`ctrl`, `opt` and `shift`, then a character, or `down`, `up`, `left`, `right`,
`return`, `tab`, `space`, `delete`, `home`, `end`, `pageup`, `pagedown` or `f1`
to `f20`.

## Experiments
<!-- slug: experiments -->

Some new features start as experiments: off unless you turn them on, while
they're tried out. Each has a switch under `experiments` in `runner.json`
in Threadbear's data folder, read at every turn, so there's nothing to
restart:

```json
"experiments": { "labReview": true }
```

Once an experiment has proved itself it becomes a standard part of
Threadbear, and its switch goes.

<!-- experiments:start -->
The ones there are now, and what each does, are in
[docs/experiments.md](experiments.md), which is made from the experiments
themselves so it stays true.
<!-- experiments:end -->

## Connectors
<!-- slug: connectors -->

Agents get services like Notion, Sentry and Cloudflare from your Connectors
gateway, and Gmail, Drive and the like from claude.ai's connectors on each
login. Now and then one needs signing in again.

The gateway is optional: it's a small server of your own
([plugbear](https://github.com/mikecann/plugbear)) that signs in to each
service once for all your logins and Macs. Without one, agents use
claude.ai's connectors alone, and Notion boards on projects aren't read.

Once there's a gateway, the Connectors icon (the plug) near the bottom of
the left-hand rail opens a panel listing the gateway's services and whether each is signed in. A blue
dot on the icon means one is signed out: click Connect beside it, and its
sign-in page opens in your browser. A grey dot means something's off that
usually sorts itself out, such as the gateway not answering for a moment.
The arrow in the panel checks again, and the ⓘ says more. If the gateway
can't be reached at all, the panel says so.

When an agent runs into a service that needs signing in, it asks you in its
reply, with a button that opens the page to do it on. That's only when the
gateway itself says the service is signed out (or claude.ai's own sign-in
error comes back), never because an email or a page the agent read says
so: those are anyone's words, so a "sign in again" in them asks nothing. claude.ai's own
connectors are signed in on claude.ai (Settings > Connectors), on the login
the thread runs on.

## The prompts macOS shows you
<!-- slug: macos-prompts -->

- **Notifications.** The first time the app opens, macOS asks whether
  Threadbear may send notifications. Either answer is fine: with them on,
  the app tells you when a thread needs you and you aren't looking at it,
  which helps most when your threads run on Full access and you've
  wandered off. You can change it later in System Settings >
  Notifications.
- **Folder access.** When an agent reaches into a protected folder, such as
  Desktop, Documents, Downloads or Dropbox, macOS asks whether to allow it.
  Click Allow if you want agents working there, or Don't Allow if not. You
  can change your mind later in System Settings > Privacy & Security >
  Files and Folders. iCloud Drive and removable drives ask too. The prompt
  names Threadbear Runner when an agent asked, and Threadbear when the app
  itself opens something there for you, such as a pinned picture on your
  Desktop. Starting threads in `~/ThreadbearThreads` keeps these prompts
  away until you choose a folder that needs them.
- **A Mac nobody's sitting at.** The agent waits for that answer, so on a
  second Mac a folder prompt can hold a thread up with nobody there to click.
  Give Threadbear Runner Full Disk Access on that Mac, in System Settings >
  Privacy & Security, and the prompts stop. Do this when you set the Mac up:
  a waiting prompt can also hold up other apps using the same drive until
  someone answers it. The trade-off is that agents there can read everything
  your account can. If a thread does get stuck like this, it
  says so after a minute or two and goes in Needs you. Five minutes later
  Threadbear stops the turn, and your next message carries on from there.
- **A thread called "... needs someone at its screen".** Threadbear starts one
  when a macOS dialog has been waiting on a Mac for 5 minutes, or when a Mac
  without the Threadbear app doesn't have Full Disk Access yet. Open Screen
  Sharing to that Mac and answer the dialog, or turn on Threadbear Runner in
  Full Disk Access there. When the dialog's gone or the access is on, the
  thread says so within a couple of minutes and archives itself, unless
  you've written in it.

## Your phone and a browser
<!-- slug: phone-and-browser -->

The Threadbear iPhone app is for when you're away from the Mac: ask a
thread a question, steer it, answer the ones that need you, start new
ones, and see how they're all getting on. Its inbox sorts threads the
way the Mac's does, into Starred, Inbox, Running, Hibernating and
Archived. To star a thread, swipe its row to the right, or use the menu when
you press and hold it or the ... menu inside it. All but Starred and Inbox start folded, showing how many they hold; tap a
heading to open or fold it, and the phone remembers. A folded Archived isn't
loaded at all, nor the hibernated threads in a folded Hibernating, so the
phone fetches less. A thread's finished turns
fold into one Worked line above the reply, as on the Mac; tap it to see
the work. The search at the top of the inbox finds any thread, hibernating
and archived ones too, by its title, last reply or project. What a thread needs from you shows under its reply with the
likely answers as buttons (type in the box to say something else; the one you tap spins until the runner has it, and the card comes back if it's refused), and
a thread that's done offers its suggested next steps and Archive, which takes you back to the inbox as its row slides away. Hibernate from a thread's ... menu does the same, with its row sinking towards the Hibernating heading. Clear the last thread from the inbox and the bear waves at you, the once. Pull the inbox down and let go to reconnect to your Mac's mirror, if the list ever looks stuck. A new thread from the phone starts in your default folder; pick its model and effort under the message, or leave them on Default. With more than one runner it starts on the first one that's online in your order, so a sleeping Mac doesn't hold it up; pick another under Runner, or change the order in Settings > Runners > Change the order. The sheet closes as soon as you tap Start, and a row at the top of the inbox says Starting until that Mac has made the thread, which then opens. If it couldn't start, the row says why; tap it to open it again as you left it, photos and choices too. Paste a photo straight into any message box, or add one with the photo button: it goes in where the cursor is as a chip, "Picture 1", as on the Mac, and pictures in your messages show as chips too. Pictures an agent puts in its reply or pins show in the thread, and animated GIFs play; tap one to see it full screen and pinch to zoom. An MP4 or MOV video an agent pins shows its first frame with a play button, and plays when you tap it. Anything over 10 MB, or from a thread that's been quiet for over two weeks, says it's on your Mac. To point one thread at another, use Copy Thread ID in its ... menu or the menu when you press and hold its row, and paste it into a message, here or on the Mac: it goes in as a link to that thread, with its title. When the Mac a thread runs on is asleep or offline, its message box says so, and what you send waits for it: each message shows faded with a Cancel under it until that Mac takes it, and Cancel puts its words back in the box. It can send notifications too,
though you don't need them for any of that. It pairs with your Mac by scanning a
QR code: on the Mac, Settings (⌘,) > Phone & browser > Show the code, then
scan it with the iPhone app. Keep the code to yourself: anyone who scans it
can run your agents. The same tab lists each paired phone and browser with
when it was paired and until when (90 days), and Revoke signs one out and
stops its notifications; Settings > Unpair this phone on the iPhone forgets it from that side. The
terminal command setup used to print still works too:

    swift ios/scripts/pair-qr.swift --prod --url <your deployment URL>

If you have them on, notifications reach your phone only while you're away
from the Mac by default. Threadbear counts you as at the Mac when the app is open and you've
used the keyboard or mouse in the last two minutes, and as away when the Mac
is asleep. On the iPhone, Settings > Notify me changes it to Always or Never.

Ask on the iPhone: press the Action button, say a question, and hear the
answer from an archive server of your own, one that knows your past
threads. Mike's is Agent Archive, which isn't public yet: he'll be talking
about it soon and releasing it then. Until then, any server that speaks
[Ask's small protocol](https://github.com/mikecann/threadbear/blob/main/docs/ask-server.md)
works. Set it up in the iPhone's Settings > Ask (the server's address and
a token from it; the phone has to be able to reach it, over Tailscale for
one on your own Mac), then set the Action button to Threadbear's Ask
shortcut. The waveform button in the inbox does the same.
Each answer is kept as a thread in your default folder, with the question,
the answer and a note that Ask answered it. It shows as done and already
read. Once it's kept, the phone opens that thread with a big mic at the
bottom: tap it and say a follow-up, which goes to the agent as an ordinary
reply on a small fast model (Haiku, or GPT-6-Luna with no Claude login; change
it in the thread if it needs more), and its answer is read out when it's done. The keyboard button
beside the mic brings back the text box. The agent is told the thread
started with Ask and picks up from there.

The Pocket is for what you'll want while you're out. Tell a thread you're
heading to the post office and its agent can file a card with the address and
what to take; the wallet button at the top of the inbox opens the deck, and
its badge says how many cards there are, in colour when one's been filed or
changed since you last opened it. The
cards are saved on the phone, so they open straight away with no signal. Tap
a card to bring it forward, then tap it again to fill the screen, black on
white, for reading out or holding up at a counter. Swipe a card left to remove
it, with a few seconds to Undo, or press and hold to copy it, open its thread
or remove it. Each card has its own icon and colour, chosen by whoever filed it. A card can name a place: while the app's
open the phone checks where you are, marks that card "here" and brings it to
the front (it asks first, and only the phone and Apple's map search see your
location). Agents replace or remove cards too, and the pencil
starts a thread to add one. The librarian looks after them as well: it updates
a thread's card when the facts change, takes it out once the thread says it's
done, and files one when you say you're going somewhere and the agent didn't.
It only touches cards from the thread it's looking at, adds at most one per
thread, and won't put an address or code on a card unless the thread said it.
The Librarian view lists what it did.

Your threads also have a website, on your own Convex deployment. To sign a
browser in, Settings > Phone & browser > Open signed in opens it in your
browser (or run `npm run web:sign-in` from your Threadbear folder). Each
thread has its own link. Open on the web in a thread's ... menu on the Mac
takes you there, and the Copy link button on the website copies it. It works
anywhere you're signed in. Its sidebar works
like the Mac's: drag its edge to resize it (double-click to reset), click a
heading to fold it, sort the Inbox from the arrows on its heading, and search
or filter from the top. The filter is only on the website: it picks threads
that need you, unread or shared ones, or one project or folder. The rail down
its left edge opens your schedules, projects, runners and each login's usage.
A schedule can be paused or run from there, and a runner shows how busy its
machine is, with an orange dot on its tile while it's low on memory or disk.
Other changes are done on the Mac or by asking an agent. The gear
has the appearance and Sign out. Pictures you paste show there too: they go to
your Convex deployment as they are, so nothing can scrub a secret from one, and
`"sync": { "pastedPictures": false }` in `runner.json` keeps them on the Mac. A tool line opens to what the tool did if its runner has full sync on (`"sync": { "full": true }` in that runner's `runner.json`; off by default, and docs/on-your-mac.md says what it sends), and its screenshots show when you tap them. The pencil beside the search starts a new
thread on a runner's default folder and login. On your Mac,
`threadbear://thread/<id>` opens a thread in the app instead (the Open
thread button on a tab BrowserBear has marked for an agent uses it).

To let someone else read a thread, click the share button beside a
thread's ... menu (or Share with others in that menu's Share submenu) and
pick Anyone with the link, then Copy link. It's a
read-only page anybody can open, which follows the thread as it carries on.
It reads like a short write-up: each of your messages, the work folded
into one "Worked for" line (open it for one line per step), the answer,
and the pictures, but not tool output, the folder or the cost. Pasted
into Slack, X or Messages, the link shows the thread's title, the start
of its last reply and its first picture. Only you stops the link working (sharing again brings
the same link back), and the arrows beside the link make a new one, which
stops the old. The same Share button is on the website, on your thread's
page and on the shared page while you're signed in.

The Mac app also draws a picture an agent writes into its reply with a path
on your Mac (`![a chart](/path/to/chart.png)`), rather than showing a link.

## Self-hosting your backend
<!-- slug: self-hosting -->

We recommend Convex cloud, which is what setup uses unless you ask for
something else. Your threads go to a Convex project in your own account,
which keeps working while your Mac is asleep, sends your phone
notifications, and needs nothing else installed. The free plan is enough
for one Mac's ordinary use.

If you'd rather keep everything on your own machine, setup can run
Convex's open source backend in Docker on your Mac instead, and reach it
over Tailscale. It's the same backend and the same features, with these
limits:

- **No phone notifications.** The push relay only works with Convex
  cloud. The iPhone app shows what needs you when you open it, and its
  Settings say why nothing arrives.
- **Your phone needs Tailscale on**, as the backend is only on your
  tailnet.
- **Nothing works while your Mac sleeps** or Docker is stopped: the phone
  and the website can't reach the backend until it's back.
- **Share links only open for people on your tailnet**, so "Anyone with
  the link" means anyone on your tailnet.

You need Docker Desktop (or OrbStack), set to start when you log in, and
Tailscale, logged in, with MagicDNS and HTTPS certificates on for your
tailnet. Then run setup with `--self-hosted`, or ask your agent to
(INSTALL.md says how):

```sh
./threadbear setup --self-hosted --yes
```

It starts the backend and its dashboard in Docker, on this Mac only, and
puts them on your tailnet with `tailscale serve`: your threads' API on port
3210, your website on 3211 and the dashboard on 6791, all at
`https://<your Mac>.<your tailnet>.ts.net`. Then it deploys Threadbear's
backend and website there as it would to Convex cloud, and keeps them up
to date the same way. Pair your phone and open the website from Settings ›
Phone & browser as usual.

The dashboard's sign-in asks for the admin key, which is in
`secrets/convex-self-hosted.env` in Threadbear's data folder. Keep it to
yourself: it can do anything to your backend. If the phone or the website
can't reach it after a restart, run `./threadbear setup` again: it starts
the backend, or makes it again on the same data. docs/self-hosting.md in the
repo has how it's put together, backing up, upgrading and taking it out.

## Patches: your own buttons and panels
<!-- slug: patches -->

A patch adds buttons and panels (beside the thread) for the threads in a
folder. A button can run a command, like your tests, send the agent a
message you use a lot, or open a web page in your browser (App Store
Connect, say), without adding anything to the thread. The web page
buttons show on the iPhone too, over the message box, and open there. A panel can show a web page, such as your app
running on localhost, or a list.

Buttons sit on shelves along the top edge of the message box, one shelf
for each place they came from, starting with the same badge the panels
wear (below). Buttons that don't fit go under a "+2" (or however many)
at the end, which lists them.

Each panel has a button on the right-hand rail, with a small badge in its
bottom corner (and on the panel's tab) saying where it came from: the project's own icon when it came
from one of the thread's projects' folders, a folder for the thread's own
folder, a house for `~/.threadbear`, a wrench for a tool patch (one that's
there because of a file, like a video's `.tandem`) and a box for one built
into Threadbear. Hover over the button to see it in words.

A thread in a Convex project gets a built-in Convex panel: the
deployment's own dashboard (data, functions, logs and so on), with a menu
to switch between Development and Production. It uses the Convex CLI on
the thread's Mac, signed in to your Convex account. If that isn't signed
in, the panel says so and has a Sign in to Convex button: your browser
opens Convex's page to approve it (for a thread on another of your Macs,
it opens on the Mac you're at), and the dashboard loads by itself once you
have. If the signed-in account can't reach the project, Sign in as someone
else switches to one that can.

You don't need to write one yourself. In a thread in that folder, ask
"add a button that runs the tests" or "add a panel showing localhost:3000",
and the agent writes the patch into the folder's `.threadbear/patches/`
(the format is under "Patches" in `docs/protocol.md`, in your Threadbear
folder). It shows up within a few seconds. A patch is code that runs on your
Mac, so keep only the ones you'd be happy to run.

Patches only run once you've trusted them. One the agent writes for you in
that folder is trusted as it wrote it (in a Claude thread on Full access;
one written in Ask before edits or Auto, or by Codex, waits for you),
though not if you turn the edit down, not a change made to it afterwards
some other way, and not other files it uses that changed some other way.
A small edit to a patch you hadn't trusted yet (one from a repo you
cloned, or a pull) doesn't trust it either: the rest of it isn't the
agent's. One that arrives some other way, in a repo you've
cloned or with a `git pull`, waits: a "patch to trust" chip shows above the
composer, and Patches lists it as "Not run yet" (or "Changed since you
trusted it") with a Trust button. Open its file to read it first, and
any files it imports or runs (a setup script, say), which Patches lists
under it: a change to one of those asks again too. A patch that loads code
by a name it works out as it runs (`import(name)`) can't be checked, so it
never runs and Patches says why: import its files by a plain path instead.
The same goes for a command a patch runs by itself, a worktree's setup or
a hook: it has to be one script in the repo with plain words after it,
like `./scripts/setup.sh --fast`, so trusting the patch covers what runs.
One like `cd scripts && ./setup.sh` or `npm run setup` never runs, and
Patches says to put the steps in a script. What that script runs in turn
(another script, a package.json script by name, a Makefile) is covered
too, so a change to any of them asks again. A script that runs something
worked out as it runs (`eval`, `bash -c "$x"`, `curl ... | sh`, a command
in a variable) can't be covered, so a setup or hook naming it never runs,
and Patches says which line. So does a chip's command: a patch with an
action that can't be followed all the way (or a `python3` one) never runs,
and pressing a chip checks the files again first, so one that's changed
since you trusted it doesn't run and asks in Patches. A patch's badges and list panels run their
commands from the folder holding its `.threadbear/`, and only while it's
the version you trusted, with only the files trusting it covered. A
thread's worktree counts as its repo, and patches that were already in
your folders when this arrived are trusted for you. Patches you trusted
before 6 Nov 2026 are asked about once more: the way their trust is
worked out changed, so the old yes can't carry over.

A repo's own Claude Code settings are asked about the same way. When its
`.claude/settings.json` or `.claude/settings.local.json` has hooks, a
status line or another command Claude runs by itself, or environment
settings (`env`, which can change where Claude sends your messages and
login, like `ANTHROPIC_BASE_URL`, or which keys it uses), or its
`.mcp.json` starts an MCP server, or one of its agents, skills or slash
commands has hooks or MCP servers of its own, Claude starts without those
until you trust them: the chip says "Hooks to trust", Patches lists
"claude-settings" with the files and the scripts they run, and the
thread says they were skipped. In a thread set to "Ask before edits" or
Auto, its permission rules that let tools run without asking (allow
rules, extra folders, a default mode, the sandbox, a skill's
`allowed-tools`) wait too, and Patches lists what they'd allow; in Full
they change nothing, so they don't ask there. The rest of the folder's
settings (deny rules, a model) and its CLAUDE.md still apply; its own
skills, agents and slash commands, and CLAUDE.md files in the folders
above it, wait too. Trust them and your next message starts Claude afresh
with all of it, carrying on the same conversation. A change to them, or
to a script they run, asks again; ones the agent writes for you on Full
access are trusted as it wrote them, as patches are. Ones that run something Threadbear can't
check (a package by name with `npx`, `python -m`, a formatter or test
runner that loads its own config and tests, a script that imports code by
a name worked out as it runs), or allow Threadbear's own tools,
can't be trusted at all, and Patches says why. Settings with none of this
in them never ask.

A project's page has its own panels and Patches on the right-hand rail:
the ones its folders give its threads.

## Changing Threadbear itself
<!-- slug: changing-threadbear -->

You can change Threadbear by asking a thread to. Start one in your
Threadbear folder (your fork, the copy setup ran from) and say what you'd
like different. If a setting or a patch would do it, the agent uses that
rather than changing Threadbear's own code, so Mike's updates come in
cleanly later. A thread there gets its own copy of the code to work in, and when
the change is ready and its checks pass, the agent lands it on your `main`
branch. When several threads are ready together, their landings wait for
one another before rebasing and checking, so each checks against the latest
landed work.

The same goes for settings. The Settings window (⌘,) shows what's set and has
controls for only a few common things, and the ⓘ beside each section says
what it is and what to ask your agent. Click it to read it, or hover for a
quick look. Most settings live in `runner.json` in Threadbear's data folder,
and an agent can change them or set up anything more involved, so ask one
first.

When something goes wrong, the app says so in an orange bar at the top of
the thread. Investigate on that bar starts a thread in your Threadbear
folder with the error, the thread it came up in, what you were doing and
which versions you're on, and asks it to find the cause and fix it. The new
thread opens and the bar goes once it's made.

Updates then arrive by themselves. Within a few minutes of a change landing
on `main`, the runner builds it and switches over without cutting off any
thread that's partway through a turn, and the app builds its new version in
the background. The app swaps in the new version when you next quit it, when
you choose Restart to Update in the Threadbear menu, or by itself when you've
left it alone for a while with nothing typed. The window stays where it is
while it does: the new version opens the same thread underneath and takes
over, so you shouldn't see it go.

A runner update lets a job a thread left running in the background finish, for
up to about 4 hours after the thread's last turn. If one goes on longer it's
stopped, and the thread gets told and wakes by itself to check on it, so you'll
see it pick back up rather than go quiet.

The Updates icon on the left-hand rail shows what's on its way for the app,
the runner and the Claude Code and Codex tools. A grey dot means something
is in progress and will sort itself out, and a coloured dot means it needs
you. Right-click it for a quick Restart to Update.

### Mike's updates

Your copy is a fork of Mike's, and it doesn't change unless you say so.
About once a day Mike publishes a release. Your runner checks for new ones
every few hours, and only trusts releases signed with the key setup saved.
When there's one your copy doesn't have, the Updates icon gets a coloured
dot, and its From Mike section lists what's new in plain words, grouped by
release. Older releases without notes show their commit subjects instead.
Bring Them In starts a
thread that merges Mike's changes with your own, sorts out any clashes,
runs the checks and asks you before it lands. Let's Discuss starts one that
talks the release through first, what's in it and what it means for your
own changes, and changes nothing until you say. From a thread, `tb updates`
says the same, and `tb updates check` looks again now.

You don't have to remember to look. Every 5 days, if Mike has a release
your copy doesn't have, Threadbear starts that thread for you: it does the
merge and runs the checks first, so it reaches your inbox with one
question, whether to land it. There's only ever one; if you leave it open,
a newer release goes into the same thread. A release Mike marks important
(a security or data fix) starts one straight away. Change how often, or
turn it off, in Settings (⌘,) > General > Updates from Mike.

### Light and dark

Threadbear follows your Mac's appearance (System Settings > Appearance)
unless you pick one for it alone: Settings (⌘,) > General > Appearance has
Same as the Mac, Light and Dark. It changes straight away and stays picked
the next time the app opens.

### A ding when a thread is done

To hear when a thread finishes, turn on Play a sound when a thread
finishes in Settings (⌘,) > General > Notifications. It's off until you
do. A soft ding then plays whenever a thread on this Mac stops working:
its reply is done, it's waiting for your answer, or it hit an error. It
plays wherever you are, in Threadbear or another app, and stays quiet for
a thread you stopped yourself. Several threads finishing at once make one
ding. Pick Chime, Bell or Droplet (each plays as you pick it), set the
volume, and press Play to hear it again.

### Talking with a thread

This is an experiment, off until you turn it on (see Experiments): there's
no button, no download and no microphone prompt while it's off.

Press the waveform button beside Send to talk with the thread out loud.
It's on a new thread's composer too: there, what you say first starts the
thread, and you carry on talking in it.
It turns red while Voice is on. Say what you want as you would to a
person; when you pause for about a second it goes to the thread as your
message, and the agent's reply is read out. You can keep talking while it
works (what you say goes into the turn it's on, as typing does), and if
you talk over it, it stops to listen. It's the same thread with the same
memory, tools and approvals. When it needs your OK it asks out loud, and
you can just say "yes", "go ahead", "no" or "always allow"; anything
longer ("no, use the other folder") goes to it as your message, as
typing would. Your answer only counts once it has finished reading the
request out and stopped talking: if another one comes in first, or you
answer before it's done, nothing is answered and it reads the newest one
to you. It only takes an answer by voice for a request it can read out
whole, a plain one-line command. Anything more (a longer command, an edit,
a plan, another Mac asking to start a thread) it names and leaves for you
to answer on screen, as you do question cards.
While Voice is on, the bear sits over the message box with what you're
saying beside it: it perks up while it listens, nods along as you talk,
looks up with thought dots while it works, and talks along with its
voice. Code and tables aren't read out; it
tells you they're on screen. Press the button again, or go to another
thread, to end Voice.

Use Voice in Settings (⌘,) > Voice turns it off, which takes the
waveform button away everywhere. The same tab picks who it sounds like (Emily, Mike and about
twenty more), how fast it talks, the language, and the microphone. Play
a Sample tries a voice. The first time you use Voice, Threadbear
downloads its voice engine (Kyutai's pocket-tts) and a voice model of
about 240 MB, and macOS asks to let it use the microphone. Listening is
done on your Mac by macOS; nothing you say is recorded or kept in a log. On headphones
(AirPods and the like) you can talk over it any time. On the Mac's
speakers you can too, as long as macOS's echo cancellation starts; when
it won't, Voice stops listening while it speaks, so it doesn't hear
itself.

### The activity log

Turn on Keep an activity log in Settings (⌘,) > General and the app notes
down what you do in it, so the agents working on Threadbear can see how you
really use it: what you click, which threads and pages you open, the menu
items and shortcuts you use, the tooltips you stop to read, and when you
send a message or answer a prompt. It never notes what you type or the
words of a message, only which button, row or item it was, by its tooltip
or its name in the menu (so clicking a thread's row puts that thread's
title in it). An agent reads it with `tb activity`, or
`tb activity --summary` for what's used most.

It's off until you turn it on. It's kept in the `activity` folder of
Threadbear's data folder, a file a day, and each file is deleted after 30
days. Threadbear never sends it anywhere, though once an agent has read
some of it, that's part of its thread like anything else it reads.

## Privacy
<!-- slug: privacy -->

Your threads are mirrored to a Convex deployment in your own Convex account,
which setup made: the thread list, the text of each message, one line for
each thing an agent did, and your logins' emails and usage. Anything that
looks like a secret is scrubbed out of the text on the way up, which helps
but isn't a guarantee. Tool output stays on your Mac. Pictures you paste into
a message go up as they are, so your website can show them, and nothing can
scrub a secret out of a picture: `"sync": { "pastedPictures": false }` in
`runner.json` keeps them on your Mac. A photo you send from your phone passes
through that deployment on its way to the Mac and is deleted once the Mac has
it; one you picked and never sent goes after a day. A message from the phone
waits up to two weeks for its Mac to take it.
A thread you share can be read by anyone with its link, pictures included,
and only that thread. The pictures are uploaded only while it's shared,
and only real pictures from its own media folder: your attachments, the
screenshots its tools took, and pictures the agent copies in there on
purpose (it's told where, as `THREADBEAR_MEDIA_DIR`). One an agent points
at anywhere else, the thread's own folder or a temp folder included,
stays on your Mac and the page shows its caption instead.
Notifications to your phone go through a small relay Mike runs, because
Apple only delivers notifications for his app through his key. The text is
locked with a key only your phone and your deployment have, so the relay
never sees what a notification says. The activity log (see
[Changing Threadbear itself](#changing-threadbear)) is off unless
you turn it on, and it stays on your Mac.

## Getting help
<!-- slug: getting-help -->

- Ask a thread. Its agent knows where this guide is and can read it, or
  look at the code and tell you how something works.
- Ask a thread to run `tb status`, which says what the runner is doing:
  its version, the threads that are busy, and any restart or update on the
  way.
- `threadbear` in Terminal opens the app, and quitting it with ⌘Q is always
  safe, since your threads keep running without it. If the app says it
  can't reach the runner, click Start runner.
- Threadbear > About Threadbear says which commit your copy was built from,
  along with a few numbers about your threads.

## The tour and Finish setting up
<!-- slug: finish-setting-up -->

The first time the app opens it shows you round the window, one part at a
time, with a few made-up sample threads to try things on: you hibernate one,
archive another, move a panel, and press an example patch's button, Roll a
die (it lives in `~/ThreadbearThreads/Welcome`). Then it opens your first
thread with the message written for you, asking the agent for a patch with
a hello button of your own, and you send it. The samples are deleted when
the tour ends. Help > Take the Tour runs it again, and that time you can
skip it. A Mac that joined a Threadbear you already use (setup's
`--existing`) skips it.

While that first thread works, Finish setting up shows what's left after
setup:

- **Start your first thread**, which shows your Claude Code or Codex login
  works. If there's no login on the Mac yet, it says how to add one.
- **Pair your iPhone**, so you can ask questions and steer your threads
  while you're out (see [Your phone and a browser](#phone-and-browser)).
- **Open your website**, to check on your threads from any browser.

Each item ticks itself off once it's done, and the list's icon on the
left-hand rail goes once they all have. Hide this list puts it away, and
Help > Finish Setting Up brings it back. The phone and website items only
show when your Threadbear has a Convex deployment for them to use.
