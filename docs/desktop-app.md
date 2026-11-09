# Using the desktop app

RocketWright is built so that you can do everything here by hand, with an agent
as a helper rather than a requirement. Press **Help** in the header, or open
**Help > Quick start**, for the short version inside the app.

## Projects

A project is a folder with a `rocketwright.toml` in it. It is yours: it lives
where you put it, and it stays there.

When RocketWright starts it reopens the project you last had open. On the first
run, or if that project cannot be opened, it shows **Welcome**, with a message
saying why when there was something to reopen.

**New project** asks for a name, a location and a template. The location starts
at `~/Documents/RocketWright`; **Choose** picks another folder, and the line
below shows the exact folder it will create.

| Template | What you get |
|---|---|
| Empty | No parts yet. Start from scratch |
| Minimal (the default) | Nose, tube, fins, motor mount and streamer, ready to fly |
| Simple rocket | A complete rocket with a parachute, ready to simulate |

**Open folder** opens a project anywhere on your disk. If the folder has no
project, RocketWright offers to create one there. It will not overwrite files
that are already in the folder: it stops and names the ones in the way.

**Open sample rocket** makes your own copy of a worked example at
`~/Documents/RocketWright/Sample rocket` (with a number added if that name is
taken), so you can change it freely.

**Recent** on Welcome and in the project menu lists the projects you have opened.
A folder that has been moved or deleted reads **Missing** and can be removed from
the list. **No access** means macOS has not let RocketWright read that folder, and
**In use** means another RocketWright or agent session has the project open.
Neither of those is removed for you, because the project is still fine.

The project name in the header opens the project menu: switch between open
projects, reach Recent, and create, open, import, export, rename or close.
**Rename project** changes the name only. The folder stays put, and because the
name is part of the design, runs you have flown become outdated and need flying
again; the dialog tells you first. **Close project** moves to your next open
project, or back to Welcome.

## Building the rocket

On **Design**, the **Components** list is the rocket's part tree. **Add part**
opens every part type RocketWright models, with **Attach to** choosing where it
goes. The **Parts library** tab searches the built-in presets by manufacturer and
type, and adds one as a new part.

Select a part to edit its fields, including position, optional and nested
fields. Values carry units (`54 mm`), and an expression starting with `=` works
wherever a number does. Changes save as you go, and each one is a step you can
undo. The status in the header tells you when everything is saved. If you quit
while a field still holds typed text, RocketWright asks first.

Right-click a part, use its menu in the inspector, or press Delete for the part
operations: **Rename**, **Duplicate**, **Move to** and **Delete**. Deleting a part
also removes its motor assignments and recovery deployments from every
configuration, in one step that **Undo** brings back.

**Materials** sits beside the part's tabs under **Components**. Browse the
project's materials and the library's, pick one to copy it into the project, or
create and edit your own.

**Configurations** pairs the airframe with motors and sets when each recovery
device deploys. The motor picker lists the built-in motors, your project's
library and anything you have imported. **Search ThrustCurve** looks up real
motors online, and it is the only thing in RocketWright that uses the network.

Adding stages and assigning parts to them is still done through the agent or the
CLI.

**Check model** in the header opens the issues, grouped by severity, each with
its code, message and **Go to part**. **2D drawing** on the Assembly toolbar
makes a dimensioned drawing, and you can tag a version from the history strip to
find it again.

## Flying it

On **Results**, every simulation has a row, including ones you have not flown.
**New simulation** adds one.

**Simulation conditions**, from a row's menu or from a row that has not been
flown, covers the rail, site, wind, atmosphere and solver. **Save** keeps your
changes without flying; **Save and run** keeps them and flies once. The menu at
the top of that sheet renames, duplicates or deletes the simulation.

**Run** flies a simulation and **Cancel** stops it. A row reads Complete, Failed,
Outdated when the design has changed since it flew, or Not run. A row's menu also has
**Edit configuration**, **Duplicate**, which copies the simulation as a new one
that has not flown, and **Delete**, which removes that stored run.

Tick up to six runs to overlay them. The plots cover altitude, velocity,
acceleration, stability, Mach, drag coefficient, mass, thrust and lateral
distance, and the numbers follow the project's units, metric or imperial.

## Liquid engines

On **Propulsion**, **Properties** holds the engine editor. **New engine**,
**Duplicate** and **Delete** manage the engines, every design input is editable
including the feed graph's nodes and connections, and **Compute** gives you the
results. After an edit the page reads **Modified, needs recompute** rather than
quietly changing the numbers.

On **Simulate**, the **Engineering** and **Visual flow** views run only when you
press **Run**. **Cancel** drops that result. **Import CFD result** picks a CFD
file from your disk. The flow preview is illustrative, not an engineering result.

## Importing and exporting

**File > Import…** takes `.ork` designs and `.eng` or `.rse` motors. You can also
drop those files onto the window. A motor joins the open project. An `.ork` on
Welcome becomes a new project; with a project open, RocketWright asks, defaulting
to a new project, and replacing the current design takes a second confirmation.
The old design stays in the history.

**File > Export…** writes an OpenRocket design (`.ork`), motor curves (RASP
`.eng`), a 3D model (`.glb`), a 3D print mesh (`.stl`) or one flown run's flight
data (`.csv`), to wherever you choose.

## Preferences

**Settings** (the gear in the header, or Cmd-,) sets the default units for new
projects and opens **Agent providers**. Each project keeps its own units, and
the **Units** control changes them for the project that is open. RocketWright
also remembers your window size and position, view options and last tab.

Shortcuts: Cmd-N new project, Cmd-O open folder, Cmd-W close project, Cmd-1 to
Cmd-4 the tabs, Cmd-Z undo, Shift-Cmd-Z redo, Cmd-, settings, and Delete removes
the selected part. In a text field, undo and redo apply to your typing.

## The agent

The pane on the right can explain results and edit the design. Every change it
makes appears in the history strip, and undo works on it the same way.

You can ask it to start a new project or open an existing one. Because an agent
thread stays in its own project, RocketWright asks you first in a native dialog,
naming what the agent wants to do, the folder, and the full text of any work it
plans to carry on with. This dialog appears even in Full access. **Cancel** leaves
everything as it was and tells the agent not to try again; if you do not answer
for about 100 seconds it cancels itself. If you accept, the window switches to the
project and a new thread there takes the remaining work, while the original thread
stays where it was.

## In a browser

`make dev BROWSER=1` serves the app to a browser. It works the same way, with
typed paths in place of the native pickers and no Recent list, native menu, or
reopening of the last project. New projects default to `~/RocketWright`, and
exports stay inside the project, in `exports/` unless you type another path
there.
