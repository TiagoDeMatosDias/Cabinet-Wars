# Cabinet Wars

Cabinet Wars is a browser strategy game of maneuver, supply and battle. Players control nations and their armies, and must either capture or defend specific locations in order to win. Play on one computer (hotseat, or against the computer) or online with friends.

**Quick start:** from a release package, unpack it and double-click **`start.bat`** (Windows), **`start.command`** (macOS) or **`start.sh`** (Linux) — nothing to install, no internet needed. From the source code: install [Node.js](https://nodejs.org) 22 or newer, then double-click **`start.bat`** (Windows) or **`start.sh`** (Linux, macOS), or run `npm start`. The game opens in your browser; new players can start with **How to play** on the main menu. See [Running the game](#running-the-game) for details, and [Playing online](#playing-online) to play with friends.

## Contents

- [The map](#the-map)
- [Nations and victory](#nations-and-victory)
- [Armies](#armies)
- [Battles](#battles)
- [Fog of war](#fog-of-war)
- [Control of nodes](#control-of-nodes)
- [Raising units](#raising-units)
- [Card decks](#card-decks)
- [Maps and custom content](#maps-and-custom-content)
- [Rules versions](#rules-versions)
- [Learning the game](#learning-the-game)
- [Playing online](#playing-online)
- [Computer players](#computer-players)
- [Saves and replays](#saves-and-replays)
- [Sound and alerts](#sound-and-alerts)
- [Running the game](#running-the-game)
- [Documentation](#documentation)
- [Credits](#credits)

## The map

The core of the game is the map. It consists of an underlying visual depiction and a set of nodes with connections between them.

- Some nodes contain victory points (VP).
- Nodes are connected to each other by **major** or **minor** roads.

## Nations and victory

- Each nation owns a set of nodes and a set of generals with their armies.
- One nation (or group of nations) is designated as the **defender**; the remaining nations are the **attacker**.
- Each nation has a predetermined percentage **willingness** to carry on the war. It depends on how many of the victory points the nation owns are still under its control.
- Losing a certain amount of victory points "knocks out" a nation: if it controls fewer victory points than required, it loses the game.
- Occupied nodes do not provide victory points to their owner, and therefore reduce its willingness to fight. If willingness dips below the nation's threshold, the nation is defeated.
- Willingness is the percentage of its own victory points a nation still controls, minus its war exhaustion: each War Exhaustion point from the Event deck takes one percentage point off.
- The threshold may increase or decrease over time, depending on the outcome of the Event deck.
- The war is won when every nation of the other side has been knocked out.

### Defeated nations

When a nation is knocked out, its armies are removed and its land is split up:
- Each node it owned goes to the **nearest nation still in the war**, measured from the nodes that nation controls. A nation already occupying one of the defeated nation's nodes is at distance 0, so occupiers keep what they hold. If several nations are equally near, the one controlling the most of the defeated nation's victory points gets the node.
- The new owner also controls the node, and any node worth more than 1 victory point is now worth 1, so the conqueror doesn't gain too much.
- Nodes the defeated nation was occupying go back under their owners' control.

### Free for all

A game can be played **free for all** instead of attackers against defenders: every nation is an attacker, at war with every other nation, and has no allies. The last nation standing wins. If the End Game card ends the war, the nation with the highest willingness wins (ties: the most victory points held). Choose the mode under **Game mode** when starting a game, or set it for a map in the map editor (`"rules": { "mode": "freeForAll" }` in `config.json`).

### Turns and rounds

- Nations take turns in the order the map lists them. A **round** ends when every nation still in the war has had its turn.
- The game counts time in rounds: the End Game card only ends the war from a certain round on (see [Card decks](#card-decks)).

## Armies

### Generals and units

- An army is made of units and generals. Units can be **cavalry**, **infantry**, **artillery** or **supply**.
- **Generals** are non-combat members, like supply units: they don't fight, and they can be detached, merged and reorganized like any unit. A general may even travel on its own.
- An army may contain multiple generals, and can therefore divide into multiple armies that operate independently.
- Separate armies may merge into one army, as long as they are on the same node.
- An army doesn't need a general to exist or to move in friendly territory. In enemy territory, an army without a general cannot move; a general must reach it before it can relocate. The exception is an army made only of supply units: supply wagons may move through enemy territory on their own.

### Movement

- An army is always on one specific node, and may only move to a node connected to it.
- An army always moves at the speed of its slowest member:

  | Unit      | Nodes per turn |
  |-----------|----------------|
  | Cavalry   | 4              |
  | General   | 4              |
  | Infantry  | 3              |
  | Artillery | 2              |
  | Supply    | 2              |

- If an army moves only along major roads, it can move three times as far in a single turn.
- An army may not move onto a node where a different army is present, unless that army belongs to the same nation.

### Supply

Armies must always be within reach of supply. Otherwise, the army loses one unit per turn until the last unit is gone, at which point the army is destroyed. An army with only generals left loses a general instead.

An army is within reach of supply if it is:

- on a friendly node (a node owned by the army's nation or an ally), or
- within 2 nodes of a friendly node, or
- within 4 nodes of a supply unit that is itself supplied.

Supply doesn't pass through enemy armies. A node holding an enemy army is not a source of supply, even if the army's side controls it, and the 2 or 4 nodes are counted only along roads free of enemy armies. For example, if friendly land at A supplies a supply unit at C through A → B → C, an enemy army on A or B cuts that supply unit off, together with the armies it supplies. Since you only see the enemy armies your fog of war shows you, a hidden enemy army can cut your supply by surprise.

This forces armies advancing into enemy territory to leave supply units behind, or suffer attrition. It also allows "chains" of supply units that provide a path to an army.

## Battles

If an army moves to a node directly connected to a node holding an enemy army, a battle occurs. The army that moved is the **attacker**; the other army is the **defender**.

Enemy armies that stand on neighbouring nodes fight even if neither moved there: after a retreat or a recruit brings them side by side, or when the map places them so at the start. Which of the two attacks is drawn at random. Such a battle happens as soon as the game settles (before the current player's next order), one pair at a time.

A battle is fought in rounds. Supply units and generals never fight; the other units are "combat units". Each round proceeds as follows:

1. **Units are drawn.** Each side fights with a number of its combat units, picked at random. How many depends on the army's total number of combat units:

   | Combat units | Fighting units |
   |--------------|----------------|
   | 1 to 3       | 1              |
   | 4 to 6       | 2              |
   | 7 to 9       | 3              |
   | More than 9  | 4              |

   Each attacking unit is then matched, also at random, with one of the defender's drawn units. Several attacking units may face the same unit. A drawn defending unit that no attacking unit faces sits the round out. Both players see the matchups.
2. **Stand or retreat.** Each player secretly chooses one of the following, and the choices are then revealed together:
   - **Fight.**
   - **Retreat card:** the battle ends and the army retreats.
   - **Block Retreat card:** the enemy's Retreat card or panic retreat this round does nothing, and the fight goes on.
   - **Panic retreat** (no card needed): one of the army's fighting units is destroyed, then the army retreats.

   A blocked Retreat card is still spent. If a retreat or panic goes through, the battle ends. If both sides get away, both retreat.
3. **Roll.** Each fighting unit rolls one six-sided die (D6), and both players see every die. Each player may then secretly put roll cards on any die: +1 or +2 on their own dice, −1 on the enemy's. For each matchup, the attacker's total (die + cards + unit bonus) is compared with the total of the defending unit it faces. The higher total wins; ties go to the defender. The losing unit is destroyed. A defending unit that faces several attackers uses the same die against each of them, and is destroyed if it loses any of those comparisons.
4. If an army has no combat units left, it is destroyed. Otherwise, start again from step 1.

**Unit types.** A unit gets **+1** when it fights a unit type it has the advantage over. This applies to both the attacker and the defender:

| Unit      | +1 against |
|-----------|------------|
| Cavalry   | Artillery  |
| Infantry  | Cavalry    |
| Artillery | Infantry   |

**Retreats.** An army that retreats leaves the battle, and the battle ends. If some of its units don't have enough movement to move 2 nodes, they are left behind and destroyed, while the rest survive. Players may play cards that grant additional moves so that more units get away. If there is no valid path, or none of its units has enough movement, the army is destroyed.

**Retreat distance.** A retreat always moves exactly 2 nodes, through nodes the army could legally enter, and the destination is chosen automatically: the node farthest from the enemy army it fought. If several are equally far, the one where the most units survive wins, then a node controlled by the army's own side. If no such route exists, the army is destroyed.

**Panic retreat.** Panicking lets an army escape without a Retreat card, at the cost of one of its units. The destroyed unit is the first of the units drawn for that round.

## Fog of war

- Each player sees armies only in the towns their side (their nation and its allies) owns or controls, in towns next to those, and in and next to towns where their own armies stand.
- Everything else is under fog of war. The map, roads and towns remain visible, but enemy armies there are hidden. Fogged areas are shaded and hatched on the map; each town covers the part of the map closest to it (a Voronoi area). An area more than 3 times the average size is split, and the part far from the town counts as wilderness that is always fogged, so empty map edges don't stay clear.
- Spy events reveal enemy armies as described in the Event deck.
- **Battles in the fog.** A player learns of a battle only if their side could see the town of either army when it began, or if their side is fighting it. Nobody else sees the battle, its log entries or its outcome.
- **Onlookers.** Players who can see a battle but are not fighting it see who fights whom and the losses, but not the units drawn, the choices, the dice or the cards. This includes the allies of either side.

## Control of nodes

- A node is always **owned** by a single, unchanging nation.
- A node is always **controlled** by one nation. If an army of another nation enters the node (stopping there at the end of a turn), that nation becomes its controller. This does not change ownership.
- A node is **protected**, and does not change controller, if an army of its current controller is within 2 nodes of it.
- An army that enters a node its own nation owns, even just passing through, ends any occupation there immediately: the node goes back under its control. Protection does not stop this.
- A node's color shows its controller, to highlight that it is under occupation.
- To return the node to its owner, the owner or an ally must occupy it again (which may or may not involve defeating the occupying army).

## Raising units

- **Unit cap.** Each nation has a soft cap on its number of units (supply units included, generals not): half the victory points it owns at the start of the game, rounded down. The cap doesn't change during the game.
- **Muster.** Once per turn, during its orders, a nation below its cap may raise one unit (cavalry, infantry, artillery or supply) in one of its own towns worth **more than 5 victory points**. The town must be under its control, with no other nation's army in it. A nation with no such town to use may muster in any of its own towns worth at least 1 victory point, under the same conditions. The unit joins the nation's army there, or forms a new army. Open the town's card to muster.
- **War status.** Click the nations in the top bar to see, for every nation, the victory points it holds and owns, its war exhaustion, its willingness and how far it is from collapse.
- **Recruit events** from the Event deck ignore the cap: they can take a nation past it.
- Running out of units, or of armies, does not knock a nation out. Only its willingness does (see [Nations and victory](#nations-and-victory)).

## Card decks

There are 2 decks, each with its own cards:

1. **Event deck**: each player draws from it at the beginning of their turn, right after drawing from the General deck. The card is revealed immediately and its event is triggered.
2. **General deck**: each player draws from it at the beginning of their turn. Players keep the cards in their hand and use them whenever they like. **Hand limit:** a nation holding 10 cards draws none; the card stays on the deck for the next player.

Both decks are shared between all players:

- Once a card is played, it is placed on the event discard pile or the general discard pile.
- When a deck has no more cards to draw, its discard pile is shuffled and becomes the new deck.
- If the discard pile is also empty, draws are skipped until there are cards in the deck again.

**Deck size.** Each nation in the game brings its own share of cards: the amounts below are for 5 nations, and a game with *n* nations has *n*/5 of each (rounded, at least one of each card). The End Game card is always single. So the decks last about as many rounds whatever the number of players — about 14 rounds for the Event deck. For example, a 2-nation game has 24 General and 28 Event cards; a 6-nation game has 72 and 83. A map's own decks (see below) are scaled the same way.

### General deck

| Card          | Amount (5 nations) | Effect                                      |
|---------------|--------|---------------------------------------------|
| +1 Roll       | 10     | +1 to roll                                  |
| +2 Roll       | 10     | +2 to roll                                  |
| −1 Roll       | 10     | −1 to roll                                  |
| Retreat       | 10     | Retreats the army                           |
| Block Retreat | 5      | Counters an enemy Retreat card: that army makes a panic retreat instead |
| +1 Moves      | 15     | Grants all units in an army +1 moves        |

### Event deck

| Card                    | Amount (5 nations) | Effect                                                                                                  |
|-------------------------|--------|---------------------------------------------------------------------------------------------------------|
| Recruit 1 Unit          | 6      | The player who drew it places a new unit (cavalry, infantry, artillery or supply, their choice) in one of their own towns that they control. It joins their army there, or forms a new army. |
| Recruit 2 Units         | 3      | As Recruit 1 Unit, twice (the two units may go to different towns). |
| Recruit General         | 3      | As Recruit 1 Unit, but places a new general. |
| End Game                | 1      | Ends the game immediately. If a defender nation is still alive, it wins (in a free-for-all game: the nation with the highest willingness). Before the map's End Game round (default: round 6), the card goes to the bottom of the Event deck instead and the war goes on. |
| +1 War Exhaustion       | 10     | Reduces the willingness to fight by 1 point.                                                            |
| +2 War Exhaustion       | 5      | Reduces the willingness to fight by 2 points.                                                           |
| +5 War Exhaustion       | 1      | Reduces the willingness to fight by 5 points.                                                           |
| Spies Successful        | 5      | Reveals the location of all enemy armies for the rest of the turn.                                      |
| Enemy Spying Successful | 5      | Reveals the location of all armies of the player who drew the card to all enemies for the rest of the turn. |
| Sabotage Successful     | 5      | Destroys 1 supply unit from any enemy army in friendly territory.                                       |
| Sabotaged               | 5      | Destroys 1 supply unit from any army owned by the player who drew the card.                             |
| Nothing                 | 20     | Nothing happens.                                                                                        |

## Maps and custom content

### Map files

A map is defined by 3 files:

- `map.png`: the background map shown to the players.
- `config.json`: lists every node (with its connections and their road type, controller, owner and victory points), every nation (and the nodes it owns), and the nations' armies, units and generals.
- `nodes.png`: an image with a circle at the location of each node, each in a unique color that is referenced in `config.json`.

The game is flexible: players can bring their own maps, nations, armies and decks simply by adding a new folder with a unique name to the `Map` folder, containing the 3 files above.

### Map editor

Maps are made in the in-browser map editor (main menu → **Map editor** → "New map in editor…"):

- **Base map…** uploads the background image.
- **Node map…** (optional) uploads an image with one colored dot per node on a transparent background, the same size as the base map; nodes are created from the dots. Without one, use **Place node** to click nodes onto the map (Shift+click moves the selected node).
- **Download** saves the map as a `.cabinetwars` file: a zip with `config.json`, `map.png` and `nodes.png` (generated from the node positions if you placed nodes by hand). Unzip it into `Map/<Name>/` to serve it from the server, or share the file as is.
- **Open…** loads a `.cabinetwars` file or a `config.json` back into the editor. "Import map…" under **Map editor** on the main menu adds one to the browser's map list.
- **Rules & decks** sets the round from which the End Game card can end the war, and how many of each card the Event and General decks contain.
- **Languages & translations** adds languages to the map and translates its names and any interface text (see [Languages](#languages)).

### Languages

All text in the game is English by default. A map can add any number of languages in its `config.json`:

```json
"languageNames": { "zh": "中文" },
"text": {
  "zh": { "map.name": "中国", "nation.qin": "秦", "node.n1": "咸阳", "controls.end": "结束回合" }
}
```

- The keys are map content (`map.name`, `nation.<id>`, `node.<id>`, `general.<id>`), interface text (the keys in `packages/client/src/i18n/en.ts`), and the game's messages (log entries such as `log.moved`, events, and error messages as `error:<English message>`). Keep `{placeholders}` as they are.
- Anything not translated shows in English.
- Players choose their language under **Settings** on the main menu or in the game's top bar, from the languages the map offers.
- Icons contain no text, so they look the same in every language.

## Rules versions

Every game records the version of the rules it is played by. Saves and replays keep theirs, so they play back exactly as they were played after the rules change.

- **Version 1** (games from before these rules existed): no hand limit, the classic deck amounts whatever the number of nations, and battles only when an army moves next to an enemy.
- **Version 2** (every new game): the 10-card hand limit, decks that grow with the number of nations, and battles between armies that stand next to each other.

## Learning the game

- **How to play** on the main menu has the rules in short, chapter by chapter, and starts the **tutorial**: a guided game against the computer on the smallest map, with notes pointing at each part of the screen. Some notes wait for the player to do what they describe (select an army, plan a move, end the turn). The tutorial can be left at any time.
- **Tooltips.** Rest the pointer on almost anything — units, towns' owner and control, victory points, supply, willingness, cards, buttons — for a short explanation.
- **Since your last turn.** When a player's turn begins, a summary lists what their side saw happen since their previous turn, turn by turn; clicking a line shows it on the map. It can be turned off under **Settings**.

## Playing online

Online games are played on the Cabinet Wars server: it keeps the game, rolls the dice, runs the computer players and sends each player only what their nations can see — nobody's browser holds the hidden information, not even the host's. The server is meant to run on one of the players' computers (see [Running the game](#running-the-game)); the others connect to it.

- **Host.** Under **Multiplayer**, choose **Host online** next to a map or a saved game. A map made or imported in the host's browser is sent to the server for the others. The lobby shows the room code and invitation links:
  - **for anyone, on any network**: a public `https://….trycloudflare.com` address the server opens for the game (see below);
  - **for your local network**: this computer's address on the network;
  - **on this computer**: for another tab or browser here.
- **Join.** Open an invitation link: with a name set (under **Settings**, or asked for on the spot), it joins straight away. Or enter the room code, or pick a game under **Open games**.
- **Lobby.**
  - Each player takes the nations they want to play (**Take this nation**) and can release them again.
  - **Colors:** click a nation's emblem to pick its color from a palette chosen to stay distinct for players with color vision deficiencies. Players color their own nations, the host any; two nations never share a color.
  - The host can play nations themselves, hand them to the computer, free the seat of a player who went offline, or **Kick** a player: their nations open up and they can't rejoin.
  - **Game options** (set by the host): the **time to act** (2, 5 or 10 minutes, or no limit), whether others may **watch** once the game has started, and whether the game shows in the list of **open games**.
  - The host starts the game; open seats are then played by the host.
- **Idle players.** A player who takes no action for the time to act when the game waits for them is moved on: their turn ends, or for any other decision (a battle, a retreat, a recruit…) the default choice is made for them. Every action restarts the clock. A clock above the turn controls shows the time left, and warns in the last minute. This also keeps a game going when a player's connection is gone.
- **Chat.** The lobby and the game have a chat for everyone at the table. It notes who joins, leaves, and takes which nation. In the game, the **Chat** button at the top left of the map opens it (or press Enter); new messages show beside it while it is closed. **Mute** (in the lobby's player list, or under **People** in the game's chat) hides a player's messages in your browser only: nobody else is affected, and the muted player isn't told.
- **Coming and going.** A player whose connection drops, or who reloads the page, rejoins by themselves with their nations. **Leave** takes a player out of the game, which carries on without them; **Multiplayer → Your games** lists the games this browser is in, to return to them. The host can leave the same way, or end the game for everyone. Games survive the server restarting.
- **Open games.** **Multiplayer → Open games** lists the games on the server that someone is playing and whose host lets them be listed.
- **Spectators.** Players who join without a nation watch the game, seeing only what every player knows.
- Each browser tab is its own player, so friends can share a computer (or you can test with two tabs).

### Connections and HTTPS

The server answers on one port (8787 by default) with both HTTPS and HTTP. Browsers require HTTPS for the game's cryptography and clipboard, so:

- `http://localhost:8787` serves this computer directly;
- other computers are sent to `https://<this computer's address>:8787`. Its certificate is made by the server itself (kept in `.cabinet-wars/tls`), so each browser asks once to trust it. To use a real certificate, set `CABINET_WARS_TLS_CERT` and `CABINET_WARS_TLS_KEY` to its PEM files;
- the public link is a [Cloudflare quick tunnel](https://try.cloudflare.com): free, no account, with a valid certificate, and no router set-up. The server opens it when someone first hosts an online game, downloading the `cloudflared` program into `.cabinet-wars/bin` the first time if it is not installed. The address changes each time the server starts. Set `CABINET_WARS_TUNNEL=off` to never open one.

Players keep the maps they downloaded, so joining again is quick even when the server's upload is slow. The server keeps its games in `.cabinet-wars/games` (removed after 30 days without play) and uploaded maps in `.cabinet-wars/uploads`.

## Computer players

Before a game starts, the lobby lists every nation of the map. The host can choose **Computer plays** for any nation that is played here or still open. In a hotseat game, any nation not played by the computer is played on this device. How the computer plays depends on the nation's role:

- **Defenders play defensively.** Their armies stay within 2 nodes of their own threatened victory points, so the enemy cannot take them, and they free any occupied towns. They attack only with a clear advantage (1.5 times the enemy's combat units). Otherwise they stand in the enemy's way to hold it up.
- **Attackers play offensively.** They march on the enemy victory points they can reach and go first for nations close to being knocked out. They attack armies they outnumber and leave their slow supply units behind to form a supply chain.
- In a **free for all** game, every nation is an attacker, so the computer always plays offensively.

The computer decides only from what its nation can see, fog of war included. It pauses briefly between moves, so players can follow them. Saves remember which nations the computer played.

## Saves and replays

The game is transactional: every move by every player, every dice roll, and every card draw and play is recorded in a JSON file.

- **Autosave.** A game played on this computer saves itself at the start of every turn; **Continue** on the main menu picks up the latest. Online games are kept by the server (see [Playing online](#playing-online)).

- This file can be saved and loaded later; the game replays up to that point and carries on from there.
- Saves are listed in the `saves` folder and come bundled with the map being played, so users can share save files and maps.
- By default, the server serves the maps available to it, while each user's browser holds the maps they created or loaded, as well as the games they saved.
- **Replays.** Any saved game can be watched again: open **Replays** on the main menu and choose **Watch replay** next to it, or **Watch replay** when a game ends (online games too: once a game is over, its whole log is everyone's). A bar along the bottom of the screen controls the replay:
  - go back or forward one **step** (a player's action, with the dice and cards that follow it) or one **turn**;
  - jump to the start or the end, or drag the slider to any point;
  - **play** it at 2, 1, ½ or ¼ seconds per step.
  - Keyboard: ← → steps, Shift + ← → turns, Space plays or pauses.
  - **View** shows everything, or a single nation's view with its fog of war. A replay can't change the game.

## Sound and alerts

- **Sounds** are made in the browser as the game plays: selecting armies and towns, writing orders, marching, drums and a horn when a battle begins, dice, cards, recruits, the chat, victory and defeat. Set the **volume** (or turn it off) under **Settings**.
- **Your turn.** A bell rings when the game waits for you. While the game's tab is in the background, its title blinks and — if you allow it under **Settings** — a notification appears.

## Running the game

The game runs in the browser; a small server on one computer serves it and hosts the online games. Everyone else only needs a browser.

There are two ways to run the server: a **release package**, which has everything in it (for any computer, even one without internet access), or the **source code**, which needs Node.js and, the first time, internet access to download its dependencies.

### Release packages (no installation, works offline)

A release package is a folder (shipped as a `.zip` for Windows, `.tar.gz` otherwise) with the built game, the server bundled into a single file, the maps and themes, and pinned copies of **Node.js** and **cloudflared** for one system. It needs nothing installed and no internet access: copy it to the computer, unpack it, and start it.

| System | Start it with |
|---|---|
| Windows | `start.bat` (double-click) |
| macOS | `start.command` (double-click; the first time, if macOS refuses it, right-click it → **Open** → **Open**) |
| Linux | `start.sh` (double-click, or `./start.sh`) |

The package's `README.txt` explains the rest. It keeps its online games, certificate and uploaded maps in its own `data/` folder. Without internet access, players join with the **local network** link (or on the same computer); the public link needs internet.

**Making packages** (from the source code, on any system):

    npm run package                 # for this computer's system
    npm run package -- win-x64      # for other systems: win-x64, linux-x64, linux-arm64, darwin-x64, darwin-arm64
    npm run package -- all          # for all of them

They are written to `release/` (about 110 MB each, archived). Making packages needs internet access once, to download Node.js (checked against its official checksums) and cloudflared; these are kept in `release/.cache`, so later packages are made offline.

**What is pinned.** Every npm dependency is at an exact version (`package.json` and `package-lock.json`; `.npmrc` keeps new ones exact), and installs use `npm ci`, which installs exactly the lockfile. The packages use Node.js 22.23.1 and cloudflared 2026.9.3 (`NODE_VERSION` in `scripts/package.mjs`, `CLOUDFLARED_VERSION` in `packages/server/src/tunnel.ts`); a server run from the source code downloads that same cloudflared version when it first needs it. Each package lists its versions in `VERSIONS.txt`, and the licenses of everything it includes in `THIRD_PARTY_LICENSES.txt`, `runtime/LICENSE` (Node.js) and `data/bin/LICENSE-cloudflared.txt`.

### Running from the source code

#### What you need

- **Node.js 22 or newer** on the computer that runs the server. Get it from [nodejs.org](https://nodejs.org):
  - **Windows:** the "LTS" Windows installer (`.msi`). Keep its default options.
  - **macOS:** the installer from nodejs.org, or `brew install node`.
  - **Linux:** your distribution's package (if it is version 22 or newer), or [nvm](https://github.com/nvm-sh/nvm).
- A current browser: Chrome, Edge, Firefox or Safari. The game is made for computers, not phones.
- An internet connection the first time, to download the dependencies (and, when an online game is first hosted, the `cloudflared` program for the public link).

#### Starting the server

| System | How |
|---|---|
| **Windows** | Double-click **`start.bat`** in the game's folder. Or, in Command Prompt or PowerShell in that folder: `.\start.bat` |
| **Linux, macOS** | Double-click **`start.sh`** (if your file manager runs scripts), or in a terminal: `./start.sh` |
| **Any system** | In a terminal in the game's folder: `npm start` |

The first start installs the dependencies (a few minutes, with internet access); every start builds the game, starts the server on **http://localhost:8787** and opens it in your browser. A window shows the server's messages: **keep it open while you play**, and close it (or press **Ctrl+C** in it) to stop the server. Online games are kept, and carry on when the server is started again.

`start.bat`, `start.sh` and `npm start` all run `scripts/start.mjs`, which takes two options: `--no-build` (start with the last build, faster) and `--no-open` (don't open the browser). For example `npm start -- --no-build`.

When the server starts, its window lists the addresses others can use on your network. Opening the game on this computer is always `http://localhost:8787`.

### Playing online with friends

1. Start the server on one computer (above). That computer must stay on, with the server running, for the game.
2. In the game, open **Multiplayer**, and choose **Host online** next to a map (or a saved game).
3. Share a link from the lobby's **Invite players** panel:
   - **Link for anyone, on any network:** works from anywhere, with no router set-up. It takes a few seconds to appear, and changes each time the server starts. Players who were in a game come back to it from **Multiplayer → Your games**.
   - **Link for your local network:** for players on the same Wi-Fi or network. Their browser warns once about the certificate (made by the server itself): choose to continue.
   - **Link on this computer:** for another browser tab or window here — handy to try things out alone.
4. Everyone picks their nations; the host starts the game.

**Firewalls.** The first time the server starts, **Windows** asks whether Node.js may communicate on networks: allow it on **private networks** so players on your local network can connect. macOS may ask the same. The link for anyone doesn't need this: it works through an outgoing connection.

### Settings

The server reads these environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | The port the server answers on (HTTP and HTTPS both) |
| `CABINET_WARS_TUNNEL` | on | `off` never opens the public link |
| `CABINET_WARS_TLS_CERT`, `CABINET_WARS_TLS_KEY` | self-signed | PEM files of a real HTTPS certificate |
| `CABINET_WARS_MAPS` | `Map/` | Folder of the maps the server offers |
| `CABINET_WARS_SAVES` | `saves/` | Folder of the saved games the server offers |
| `CABINET_WARS_THEMES` | `themes/` | Folder of the interface themes |
| `CABINET_WARS_DATA` | `.cabinet-wars/` | Where the server keeps its certificate, the `cloudflared` program, online games and uploaded maps |

To set one for a start:
- **Windows, Command Prompt:** `set PORT=8788`, then `start.bat`
- **Windows, PowerShell:** `$env:PORT=8788; .\start.bat`
- **Linux, macOS:** `PORT=8788 ./start.sh`

### Where things are kept

- **On the server's computer**, in `.cabinet-wars/` in the game's folder: `tls/` (the HTTPS certificate), `bin/` (`cloudflared`), `games/` (online games; removed after 30 days without play) and `uploads/` (maps hosts sent from their browsers). Deleting it is safe when no game is running; the server makes what it needs again.
- **In each player's browser:** their name and settings, the maps they made or imported, their saves and autosaves, the maps of online games they joined, and the list of their online games.

### Building and testing by hand

    npm install         # dependencies
    npm test            # rules and table tests (vitest)
    npm run typecheck   # TypeScript checks
    npm run build       # build the browser client into packages/client/dist
    npm run server      # start the server only (it serves the last build)

These work the same on Windows (Command Prompt or PowerShell), macOS and Linux. During development, run `npm run server` and `npm run dev` (Vite, with live reload; it forwards /api and /ws to the server) together, and open the address Vite prints.

The game was called Krieg while it was being made. Files and settings from then still work: `.krieg` map and save files open like `.cabinetwars` ones, `KRIEG_*` environment variables are read when the `CABINET_WARS_*` ones aren't set, and a `.krieg` data folder is moved to `.cabinet-wars` when the server first starts.

### Code layout

- `packages/engine`: pure rules engine, shared by everything.
- `packages/table`: a game and the people at it — randomness, computer players, seats, colors, chat, the idle clock — and the protocol between browsers and the server. The server runs one per online game; the browser runs one for games on this computer.
- `packages/server`: static files, map/save listings, online games (`/ws`), map uploads, HTTPS certificate and public tunnel.
- `packages/client`: PixiJS map, game UI, map editor, tutorial, sounds, and the local and online sessions.
- `scripts/start.mjs`: the launcher behind `start.bat`, `start.sh` and `npm start`.
- `scripts/package.mjs`: makes the release packages; `scripts/release/` holds what goes into them besides the build (launchers, `README.txt`).

## Documentation

- [Design system: themeable UI](docs/design-system.md): how each map can have its own interface style, the design tokens a theme must define, how to write a theme, and the canonical Imperial China theme.
- [Game screen: layout and interaction](docs/game-screen.md): the in-game layout, nation emblems, cards, 3D armies, the army card, the orders (step) list, turn controls, the battle panel and the log.

## Credits

- **Art and sound.** Maps, emblems and unit miniatures were made for this game with the help of AI image and model generation. Sounds are synthesized in the browser.
- **Fonts.** [LXGW WenKai](https://github.com/lxgw/LxgwWenKai) (via lxgw-wenkai-webfont) and [Noto Serif SC](https://fonts.google.com/noto/specimen/Noto+Serif+SC) (via Fontsource), both under the SIL Open Font License 1.1.
- **Software.** [PixiJS](https://pixijs.com) and pixi-viewport (the map), [three.js](https://threejs.org) (3D miniatures), d3-delaunay (fog areas), fflate (save files), Zod (map validation), ws (server connections), selfsigned (HTTPS certificate) — MIT or ISC licensed; [cloudflared](https://github.com/cloudflare/cloudflared) (public links, Apache 2.0, downloaded when first needed). Built and tested with Vite, TypeScript, tsx and Vitest.

The same credits are in the game, under **Settings → About → Credits**.
