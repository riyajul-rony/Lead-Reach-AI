#!/usr/bin/env bash
set -euo pipefail

echo "=============================================="
echo "        Lead Reach AI SaaS VPS Deployment           "
echo "=============================================="

# 1. Select compose file (Traefik docker-compose.yml by default, or standalone Caddy)
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
if [ "${1:-}" = "--standalone" ]; then
  COMPOSE_FILE="docker-compose.standalone.yml"
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ Error: Compose file '$COMPOSE_FILE' not found."
  exit 1
fi

echo "ℹ️  Using compose file: $COMPOSE_FILE"
echo "   (Pass --standalone or set COMPOSE_FILE=docker-compose.standalone.yml for Caddy mode)"

# 2. Environment validation
if [ ! -f .env ]; then
  echo "❌ Error: .env file not found."
  echo "   Please copy .env.example to .env and configure your secrets:"
  echo "   cp .env.example .env && nano .env"
  exit 1
fi

# Load environment variables
export $(grep -v '^#' .env | xargs)

if [ -z "${POSTGRES_PASSWORD:-}" ] || [ "${POSTGRES_PASSWORD:-}" = "change-me" ]; then
  echo "❌ Error: POSTGRES_PASSWORD in .env must be set to a secure custom password."
  exit 1
fi

# 3. Check Docker and Docker Compose
command -v docker >/dev/null 2>&1 || {
  echo "❌ Docker is not installed. Please install Docker first: curl -fsSL https://get.docker.com | sh"
  exit 1
}

# 4. Ensure 2 GB Swap space is active (critical for 1-2 vCPU VPS)
if [ -x "scripts/setup-swap.sh" ]; then
  echo "Checking swap space..."
  bash scripts/setup-swap.sh || echo "Notice: Swap setup skipped (requires root)"
fi

# 5. Pull and build containers
echo "📦 Building and pulling latest Lead Reach AI containers..."
docker compose -f "$COMPOSE_FILE" build --pull web

# 6. Bring up core infrastructure (DB and Redis)
echo "🗄️ Starting database and Redis..."
docker compose -f "$COMPOSE_FILE" up -d db redis

# Wait for database healthcheck
echo "Waiting for PostgreSQL to be healthy..."
until docker compose -f "$COMPOSE_FILE" exec -T db pg_isready -U "${POSTGRES_USER:-leadreach}" -d "${POSTGRES_DB:-leadreach}" >/dev/null 2>&1; do
  sleep 2
done
echo "✅ Database is ready."

# 7. Run database migrations
echo "🔄 Applying Prisma migrations..."
docker compose -f "$COMPOSE_FILE" run --rm --no-deps web npx prisma migrate deploy

# 8. Start Web, Worker, and optional Caddy (standalone mode only)
SERVICES=(web worker)
if docker compose -f "$COMPOSE_FILE" config --services | grep -qx "caddy"; then
  SERVICES+=(caddy)
fi

echo "🚀 Starting services: ${SERVICES[*]}..."
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans "${SERVICES[@]}"

# 9. Verify service health
echo "🩺 Verifying container health status..."
sleep 5
docker compose -f "$COMPOSE_FILE" ps

echo "=============================================="
echo "🎉 Lead Reach AI SaaS successfully deployed!"
echo "   Domain: https://${APP_DOMAIN:-localhost}"
echo "=============================================="
