# Docker Lab — learn Docker visually

An interactive website that teaches Docker from zero to advanced. Every concept has an animation you can play with, every command is explained flag by flag, and every file is explained line by line.

**Live site:** https://kunalavghade.github.io/dockerlab/

## What's inside

- **23 lessons** in three levels:
  - **Beginner:** what Docker is, architecture, images and containers, your first container, lifecycle, everyday commands
  - **Intermediate:** Dockerfile, layer caching, port mapping, volumes, networking, environment config, Compose, cleanup, debugging containers, snapshots and moving images
  - **Advanced:** multi-stage builds, registries, multi-platform builds and contexts, limits, health and restarts, security, orchestration, stacks and secrets
- **Command reference with 137 commands** (`#/commands`): containers, images, build/buildx, volumes, networks, Compose, contexts, Swarm, stacks, secrets, configs and Scout. Each page has the syntax, what the command does, every important option, examples you can run or have explained token by token, common errors, and a **live lab** with its own simulated engine and a picture of containers, images, networks and volumes.
- **Interactive animations** in every lesson: VMs vs containers, build layers, cache hits, port forwarding, volumes, DNS between containers, Compose up and down, rolling updates and more.
- **Type real commands into every animation.** Each one has a small terminal: type `docker run -d -p 3000:80 nginx`, then `curl localhost:3000`, and watch the request travel. Each terminal suggests commands that fit the current state and explains why a command can't run yet.
- **Command explainer:** hover or click any part of a command to see what it does.
- **File explainer:** step through a Dockerfile, `compose.yaml`, `.dockerignore` or `.env` one line at a time.
- **Quizzes** that mark a lesson complete. Progress is saved in your browser.
- **Playground:** a simulated Docker engine with a terminal, a live view of images, containers, networks and volumes, and 15 challenges. It supports pipes (`| grep`, `| jq`), `$(…)`, `&&`, redirects, shells inside containers (`docker exec -it web sh`), Compose, Swarm across several machines (`ssh worker-1 …`), contexts, buildx and registries.
- **Cheat sheet:** a searchable list of commands. Click one to copy it.

## Run locally

It's a static site with no build step. Serve the folder with any static server (ES modules don't load over `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy on GitHub Pages

Deployment is automatic: every push to `main` runs [.github/workflows/pages.yml](.github/workflows/pages.yml), which checks the JavaScript and publishes the site.

One-time setup: in the repository go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.

## Project layout

```
index.html              App shell
assets/css/style.css    Theme (white, blue, black lines)
assets/js/app.js        Router, sidebar, pages
assets/js/lessons.js    All lesson content and the cheat sheet (data only)
assets/js/animations.js One interactive animation per lesson
assets/js/components.js Command explainer, file explainer, scene frame, quiz
assets/js/animations-more.js Animations for debugging, snapshots, buildx, contexts, stacks
assets/js/reference.js  Command reference index (entries live in assets/js/ref/)
assets/js/commands.js   Command reference pages and token explainer
assets/js/terminal.js   Terminal UI bound to the simulated engine
assets/js/stateview.js  Live picture of engine state
assets/js/playground.js Playground page and challenges
assets/js/sim/          Simulated Docker engine (runs in the browser and in Node)
assets/js/dom.js        DOM, storage and animation timing helpers
examples/               Small example projects
```

## Test

```bash
npm test
```

This runs every command-reference lab (setup and examples) against the simulated engine. CI runs it before every deploy.

## Add a command

Add an entry to one of the files in `assets/js/ref/` (shape documented in `assets/js/reference.js`). If the engine does not know the command yet, add it to the matching module in `assets/js/sim/`. Then run `npm test`.

## Add a lesson

1. Add an entry to `LESSONS` in `assets/js/lessons.js`, using blocks such as `['p', html]`, `['cmd', {...}]`, `['file', {...}]` and `['anim', 'key']`.
2. If it needs a new animation, add `ANIMATIONS.key = (root) => { ... }` in `assets/js/animations.js`, using the `scene()` helper.
3. To make a step typeable, pass `cmd` (a string or RegExp) to `s.btn(...)`, or register a command with no button using `s.command(patterns, fn, { enabled, example, why })`.
