#!/bin/sh
set -e

echo "Starting Lead Reach AI entrypoint..."

# 1. Fix volume permissions for mounted /data (handles existing root-owned volumes safely)
mkdir -p /data/uploads /data/backups
if [ "$(id -u)" = "0" ]; then
  chown -R nextjs:nodejs /data
fi

# 2. Generate secrets if missing
if [ -z "$AUTH_SECRET" ] || [ -z "$APP_ENCRYPTION_KEY" ]; then
  if [ ! -f /data/.secrets ]; then
    echo "Generating new random secrets into /data/.secrets..."
    AUTH_SEC=$(head -c 32 /dev/urandom | base64)
    APP_KEY=$(head -c 32 /dev/urandom | base64)
    echo "AUTH_SECRET=$AUTH_SEC" >> /data/.secrets
    echo "APP_ENCRYPTION_KEY=$APP_KEY" >> /data/.secrets
    chmod 600 /data/.secrets
    if [ "$(id -u)" = "0" ]; then
      chown nextjs:nodejs /data/.secrets
    fi
  fi
  # Export stored secrets
  export $(cat /data/.secrets | xargs)
fi

# 3. Run migrations only if we are the web service container
if [ "$SERVICE_ROLE" = "web" ]; then
  echo "Waiting for PostgreSQL database to be ready..."
  for i in $(seq 1 30); do
    if [ "$(id -u)" = "0" ]; then
      if gosu nextjs npx prisma migrate deploy; then
        echo "Prisma migrations applied successfully."
        break
      fi
    else
      if npx prisma migrate deploy; then
        echo "Prisma migrations applied successfully."
        break
      fi
    fi
    echo "Database not ready yet, retrying in 2 seconds... ($i/30)"
    sleep 2
  done
fi

# 4. Drop root privileges and execute command as nextjs user
if [ "$(id -u)" = "0" ]; then
  exec gosu nextjs "$@"
else
  exec "$@"
fi
