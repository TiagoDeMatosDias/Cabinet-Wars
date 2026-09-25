# Krieg

Krieg is a small browser game inspired by the board game Friedrich.

It is a multiplayer strategy game in which players control nations and their armies, and must either capture or defend specific locations in order to win.

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
- [Computer players](#computer-players)
- [Saves and replays](#saves-and-replays)
- [Running the game](#running-the-game)
- [Documentation](#documentation)

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

This forces armies advancing into enemy territory to leave supply units behind, or suffer attrition. It also allows "chains" of supply units that provide a path to an army.

## Battles

If an army moves to a node directly connected to a node holding an enemy army, a battle occurs. The army that moved is the **attacker**; the other army is the **defender**.

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
2. **General deck**: each player draws from it at the beginning of their turn. Players can keep any number of cards in their hand and use them whenever they like.

Both decks are shared between all players:

- Once a card is played, it is placed on the event discard pile or the general discard pile.
- When a deck has no more cards to draw, its discard pile is shuffled and becomes the new deck.
- If the discard pile is also empty, draws are skipped until there are cards in the deck again.

### General deck

| Card          | Amount | Effect                                      |
|---------------|--------|---------------------------------------------|
| +1 Roll       | 10     | +1 to roll                                  |
| +2 Roll       | 10     | +2 to roll                                  |
| −1 Roll       | 10     | −1 to roll                                  |
| Retreat       | 10     | Retreats the army                           |
| Block Retreat | 5      | Counters an enemy Retreat card: that army makes a panic retreat instead |
| +1 Moves      | 15     | Grants all units in an army +1 moves        |

### Event deck

| Card                    | Amount | Effect                                                                                                  |
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
- **Download** saves the map as a `.krieg` file: a zip with `config.json`, `map.png` and `nodes.png` (generated from the node positions if you placed nodes by hand). Unzip it into `Map/<Name>/` to serve it from the server, or share the file as is.
- **Open…** loads a `.krieg` file or a `config.json` back into the editor. "Import map…" under **Map editor** on the main menu adds one to the browser's map list.
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

## Computer players

Before a game starts, the lobby lists every nation of the map. The host can choose **Computer plays** for any nation that is played here or still open. In a hotseat game, any nation not played by the computer is played on this device. How the computer plays depends on the nation's role:

- **Defenders play defensively.** Their armies stay within 2 nodes of their own threatened victory points, so the enemy cannot take them, and they free any occupied towns. They attack only with a clear advantage (1.5 times the enemy's combat units). Otherwise they stand in the enemy's way to hold it up.
- **Attackers play offensively.** They march on the enemy victory points they can reach and go first for nations close to being knocked out. They attack armies they outnumber and leave their slow supply units behind to form a supply chain.
- In a **free for all** game, every nation is an attacker, so the computer always plays offensively.

The computer decides only from what its nation can see, fog of war included. It pauses briefly between moves, so players can follow them. Saves remember which nations the computer played.

## Saves and replays

The game is transactional: every move by every player, every dice roll, and every card draw and play is recorded in a JSON file.

- This file can be saved and loaded later; the game replays up to that point and carries on from there.
- Saves are listed in the `saves` folder and come bundled with the map being played, so users can share save files and maps.
- By default, the server serves the maps available to it, while each user's browser holds the maps they created or loaded, as well as the games they saved.
- **Replays.** Any saved game can be watched again: open **Replays** on the main menu and choose **Watch replay** next to it, or **Watch replay** when a game ends. A bar along the bottom of the screen controls the replay:
  - go back or forward one **step** (a player's action, with the dice and cards that follow it) or one **turn**;
  - jump to the start or the end, or drag the slider to any point;
  - **play** it at 2, 1, ½ or ¼ seconds per step.
  - Keyboard: ← → steps, Shift + ← → turns, Space plays or pauses.
  - **View** shows everything, or a single nation's view with its fog of war. A replay can't change the game.

## Running the game

Requires Node 22.

    npm install
    npm test            # engine rules tests (vitest)
    npm run build       # build the browser client
    npm run server      # http://localhost:8787 — serves the client, Map/*, saves/*, and WebRTC signaling

During development, run `npm run server` and `npm run dev` (Vite, proxies /api and /ws to the server) together.

### Code layout

- `packages/engine`: pure rules engine, shared by everything.
- `packages/server`: static files, map/save listings, signaling.
- `packages/client`: PixiJS map, game UI, map editor, P2P host/peer sessions.

## Documentation

- [Design system: themeable UI](docs/design-system.md): how each map can have its own interface style, the design tokens a theme must define, how to write a theme, and the canonical Imperial China theme.
- [Game screen: layout and interaction](docs/game-screen.md): the in-game layout, nation emblems, cards, 3D armies, the army card, the orders (step) list, turn controls, the battle panel and the log.
