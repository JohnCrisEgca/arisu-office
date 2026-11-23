# Arisu Office

A small, original AI-office dashboard: an office floor with 18 AI agents, each with a role and a room (Command Deck, Research Lab, Content Studio, Ops Room, Shared Brain), a task queue that auto-assigns work to the least-busy agent, and an activity log.

Everything is in one file, `index.html`. No build step and no dependencies. Open it in a browser.

## What it does
- Shows all agents on a canvas floor plan; click an agent or a dot to inspect it.
- Add tasks; Arisu (Chief of Staff) assigns each to the least-loaded agent.
- Mark tasks done; the activity log records it.
- Tasks persist in the browser's localStorage (per-viewer only).

## Agents and roles
All agent names, roles, rooms and the shared-brain notes were written for this project. They are not connected to any external service yet; the "working / idle" states are simulated locally.

## Roadmap
- Connect real agents via an API instead of simulated status.
- Sync tasks to a shared backend.
- Wire up Discord/Trello integrations.
