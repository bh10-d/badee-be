# PrintFarm Backend (NestJS + PostgreSQL)

Standalone backend repository for the multi-brand 3D Print Farm & Rental Platform.

## Quick Start (Ports >= 6000)

```powershell
Copy-Item .env.example .env
docker compose up -d
npm install
npx prisma generate
npx prisma db push
npm run prisma:seed
npm test
npm run dev
```

- **REST API:** `http://127.0.0.1:6001/api/health`
- **WebSocket:** `ws://127.0.0.1:6001/ws`
- **PostgreSQL:** `127.0.0.1:6432`
- **Docs:** [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) · [docs/WORKFLOW_HISTORY.md](./docs/WORKFLOW_HISTORY.md)
