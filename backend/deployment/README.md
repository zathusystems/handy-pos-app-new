# Handy POS Backend VPS Deployment

This guide is for hosting the Django backend on a VPS behind Nginx.

It assumes:

- Ubuntu 22.04 or 24.04
- A DNS name such as `api.example.com`
- PostgreSQL on the VPS
- Gunicorn as the Django app server
- Nginx as the reverse proxy
- Optional Redis/Celery if you want background jobs enabled

## Files In This Folder

- `env.production.example`: production environment template
- `nginx/handypos-backend.conf`: Nginx site config
- `systemd/handypos-gunicorn.service`: Gunicorn service
- `systemd/handypos-celery.service`: optional Celery worker service
- `systemd/handypos-celery-beat.service`: optional Celery beat service

## Step 1: Point Your Domain To The VPS

Create an `A` record for your API host, for example:

- `api.example.com -> <your-vps-ip>`

Wait until DNS resolves before continuing.

## Step 2: Install System Packages

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip libpq-dev postgresql postgresql-contrib nginx
```

If you plan to run Celery:

```bash
sudo apt install -y redis-server
```

## Step 3: Create The App Directory

This guide uses `/srv/handy-pos`.

```bash
sudo mkdir -p /srv/handy-pos
sudo chown $USER:$USER /srv/handy-pos
cd /srv/handy-pos
git clone <your-repo-url> .
```

If you want the service to run as the dedicated `handypos` user used in the sample
systemd files, create it now and hand ownership over to it:

```bash
sudo adduser --system --group --home /srv/handy-pos handypos
sudo chown -R handypos:www-data /srv/handy-pos
```

If you prefer another user, edit the systemd templates before enabling them.

## Step 4: Create The Python Environment

```bash
cd /srv/handy-pos/backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

## Step 5: Create The Production Env File

Copy the template and fill in real values:

```bash
cp deployment/env.production.example .env
nano .env
```

Minimum values to change:

- `DEBUG=False`
- `ENVIRONMENT=production`
- `SECRET_KEY=<strong-random-secret>`
- `ALLOWED_HOSTS=api.example.com`
- `CORS_ALLOWED_ORIGINS=https://app.example.com`
- `CSRF_TRUSTED_ORIGINS=https://api.example.com,https://app.example.com`
- `PAYMENT_PUBLIC_BASE_URL=https://api.example.com`
- `DB_NAME`, `DB_USER`, `DB_PASSWORD`

If you will host the frontend somewhere else, update its build env too:

- `NEXT_PUBLIC_API_URL=https://api.example.com/api`
- `NEXT_PUBLIC_API_BASE_URL=https://api.example.com/api`
- `NEXT_PUBLIC_DJANGO_URL=https://api.example.com`

## Step 6: Create The PostgreSQL Database

```bash
sudo -u postgres psql
```

Inside PostgreSQL:

```sql
CREATE DATABASE handy_pos_db;
CREATE USER handy_pos_db_user WITH PASSWORD 'change-this-password';
ALTER ROLE handy_pos_db_user SET client_encoding TO 'utf8';
ALTER ROLE handy_pos_db_user SET default_transaction_isolation TO 'read committed';
ALTER ROLE handy_pos_db_user SET timezone TO 'UTC';
GRANT ALL PRIVILEGES ON DATABASE handy_pos_db TO handy_pos_db_user;
\q
```

## Step 7: Run Django Setup Commands

```bash
cd /srv/handy-pos/backend
source .venv/bin/activate
export DJANGO_SETTINGS_MODULE=core.prod_settings
python manage.py migrate
python manage.py collectstatic --noinput
python manage.py createsuperuser
python manage.py check --deploy
```

If `check --deploy` reports anything important, fix it before going live.

## Step 8: Test Gunicorn Manually

```bash
cd /srv/handy-pos/backend
source .venv/bin/activate
export DJANGO_SETTINGS_MODULE=core.prod_settings
gunicorn --bind 127.0.0.1:8001 --workers 3 --timeout 120 core.wsgi:application
```

In another shell:

```bash
curl http://127.0.0.1:8001/health/
```

You should get a healthy JSON response.

Stop Gunicorn with `Ctrl+C` after the test.

## Step 9: Install The systemd Service

Copy the template and edit the paths, user, and group if needed:

```bash
sudo cp deployment/systemd/handypos-gunicorn.service /etc/systemd/system/
sudo nano /etc/systemd/system/handypos-gunicorn.service
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now handypos-gunicorn
sudo systemctl status handypos-gunicorn
```

Useful commands:

```bash
sudo journalctl -u handypos-gunicorn -f
sudo systemctl restart handypos-gunicorn
```

## Step 10: Install The Nginx Site

Copy the template:

```bash
sudo cp deployment/nginx/handypos-backend.conf /etc/nginx/sites-available/handypos-backend
sudo nano /etc/nginx/sites-available/handypos-backend
sudo ln -s /etc/nginx/sites-available/handypos-backend /etc/nginx/sites-enabled/handypos-backend
sudo nginx -t
sudo systemctl reload nginx
```

At this stage the site can run on plain HTTP.

## Step 11: Add HTTPS With Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

After Certbot finishes, test:

```bash
curl -I https://api.example.com/health/
```

## Step 12: Optional Celery Services

This repo already has background tasks in `subscription` and `mra_eis`.
If you want them running in production:

1. Install and start Redis.
2. Make sure `CELERY_BROKER_URL` and `CELERY_RESULT_BACKEND` are set.
3. Copy the service files from `deployment/systemd/`.
4. Enable them:

```bash
sudo cp deployment/systemd/handypos-celery.service /etc/systemd/system/
sudo cp deployment/systemd/handypos-celery-beat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now handypos-celery
sudo systemctl enable --now handypos-celery-beat
```

## Step 13: Smoke Test After Go-Live

Run these from your laptop or the VPS:

```bash
curl https://api.example.com/health/
curl -I https://api.example.com/admin/
curl -I https://api.example.com/static/admin/css/base.css
```

Then verify:

- Admin login works
- API login works
- Static assets load
- Mobile/desktop clients can reach the API
- CORS is correct for your frontend origin

## PayChangu Deep-Link Setup

For the Tauri and Android app flow, configure the Django payment gateway admin like this:

- `callback_url=handypos://subscription-payment/{deposit_id}`
- `return_url=handypos://subscription-payment/{deposit_id}`

Do not give PayChangu the `handypos://` URL directly. The backend converts that app deep link into public HTTPS bridge URLs using `PAYMENT_PUBLIC_BASE_URL`, for example:

- Callback bridge: `https://api.example.com/api/payments/subscription/checkout/return/{deposit_id}/?target=callback&app_redirect=handypos%3A%2F%2Fsubscription-payment%2F{deposit_id}`
- Return bridge: `https://api.example.com/api/payments/subscription/checkout/return/{deposit_id}/?target=return&app_redirect=handypos%3A%2F%2Fsubscription-payment%2F{deposit_id}`

Use this webhook URL in PayChangu:

- `https://api.example.com/api/payments/webhooks/paychangu/`

## Common Notes

- Use `core.prod_settings` on the VPS. It is an importable alias for production deployment.
- Nginx terminates SSL, and Django now trusts `X-Forwarded-Proto`.
- Static files are expected in `/srv/handy-pos/backend/staticfiles`.
- Media files are expected in `/srv/handy-pos/backend/media`.
- If you change directories, update both the systemd file and the Nginx config.
