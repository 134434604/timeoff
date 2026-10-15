# Time Off

Time-off requests, manager approval, balances that accrue, and approved days
written to the company's shared Google Calendar. One small company, Google
Workspace sign-in, no passwords.

- One prompt that walks the owner through the whole setup in Claude: [docs/ONE-PROMPT.md](docs/ONE-PROMPT.md)
- Launch plan, who does what: [docs/LAUNCH.md](docs/LAUNCH.md)
- Owner's guide: [docs/HANDOFF.md](docs/HANDOFF.md)
- The two things only the owner can set up (Google, Slack): [docs/OWNER-SETUP.md](docs/OWNER-SETUP.md)
- Setup and operations: [docs/SETUP.md](docs/SETUP.md)
- Hosting in the company's Google Cloud: [docs/HOSTING-GOOGLE-CLOUD.md](docs/HOSTING-GOOGLE-CLOUD.md)
- Client/server contract: [docs/API.md](docs/API.md)
- Rules for anyone changing the code: [AGENTS.md](AGENTS.md)

```bash
npm install
npm run check          # syntax, types, unit tests
npm run build:client   # Vite -> dist/
npm start              # serves dist/ and the API on http://127.0.0.1:5610
```

Stack: Node 22+ (`node:http`, `node:sqlite`), no runtime npm dependencies;
Vite + React + TypeScript client. Everything the app knows lives in
`data/`, which is never committed or deployed.
