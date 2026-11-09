// Static data for the simulated engine: the fake Docker Hub, base file systems and the
// project folder the playground starts in. Add an image by adding an entry to HUB.

const ARCHES = ['linux/amd64', 'linux/arm64', 'linux/arm/v7'];

const NGINX_INDEX = '<!DOCTYPE html>\n<html><head><title>Welcome to nginx!</title></head>\n<body><h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and working.</p></body></html>';

export const HUB = {
  nginx: {
    mb: 192, kind: 'server', cmd: ['nginx', '-g', 'daemon off;'], entrypoint: ['/docker-entrypoint.sh'], port: 80, stars: 20900, official: true,
    desc: 'Official build of Nginx.', os: 'Debian GNU/Linux 12 (bookworm)', user: 'root', stopSignal: 'SIGQUIT',
    log: ['/docker-entrypoint.sh: Configuration complete; ready for start up', '2026/11/09 10:00:00 [notice] 1#1: nginx/1.27.2', '2026/11/09 10:00:00 [notice] 1#1: start worker processes'],
    files: {
      '/usr/share/nginx/html/index.html': NGINX_INDEX,
      '/usr/share/nginx/html/50x.html': '<h1>An error occurred.</h1>',
      '/etc/nginx/nginx.conf': 'user nginx;\nworker_processes auto;\nevents { worker_connections 1024; }\nhttp { include /etc/nginx/conf.d/*.conf; }',
      '/etc/nginx/conf.d/default.conf': 'server {\n  listen 80;\n  location / { root /usr/share/nginx/html; index index.html; }\n}',
    },
    runtimeDiff: ['/run/nginx.pid', '/var/cache/nginx/client_temp', '/var/cache/nginx/proxy_temp'],
  },
  httpd: { mb: 148, kind: 'server', cmd: ['httpd-foreground'], port: 80, stars: 4800, official: true, desc: 'The Apache HTTP Server Project.', os: 'Debian GNU/Linux 12 (bookworm)', log: ['AH00558: httpd: Could not reliably determine the server\'s fully qualified domain name', 'Apache/2.4.62 (Unix) configured -- resuming normal operations'], files: { '/usr/local/apache2/htdocs/index.html': '<html><body><h1>It works!</h1></body></html>' }, runtimeDiff: ['/usr/local/apache2/logs/httpd.pid'] },
  redis: { mb: 138, kind: 'server', cmd: ['redis-server'], port: 6379, stars: 13000, official: true, desc: 'Redis is the world’s fastest data platform.', os: 'Debian GNU/Linux 12 (bookworm)', user: 'redis', log: ['1:C 09 Nov 2026 10:00:00.000 * Redis version=7.4.1, bits=64', '1:M 09 Nov 2026 10:00:00.001 * Ready to accept connections tcp'], files: { '/data/.keep': '' } },
  postgres: { mb: 438, kind: 'server', cmd: ['postgres'], port: 5432, stars: 13900, official: true, needs: 'POSTGRES_PASSWORD', desc: 'The PostgreSQL object-relational database system.', os: 'Debian GNU/Linux 12 (bookworm)', user: 'postgres', log: ['PostgreSQL init process complete; ready for start up.', 'LOG:  database system is ready to accept connections'], files: { '/var/lib/postgresql/data/PG_VERSION': '16' }, runtimeDiff: ['/var/run/postgresql/.s.PGSQL.5432'] },
  mysql: { mb: 586, kind: 'server', cmd: ['mysqld'], port: 3306, stars: 15600, official: true, needs: 'MYSQL_ROOT_PASSWORD', desc: 'MySQL is a widely used, open-source relational database.', os: 'Oracle Linux Server 9', log: ['[Server] /usr/sbin/mysqld: ready for connections. Version: \'8.4.3\''] },
  mongo: { mb: 757, kind: 'server', cmd: ['mongod'], port: 27017, stars: 10400, official: true, desc: 'MongoDB document databases.', os: 'Ubuntu 22.04', log: ['{"msg":"Waiting for connections","attr":{"port":27017}}'] },
  alpine: { mb: 7.8, kind: 'shell', cmd: ['/bin/sh'], stars: 11000, official: true, desc: 'A minimal Docker image based on Alpine Linux.', os: 'Alpine Linux v3.20' },
  busybox: { mb: 4.3, kind: 'shell', cmd: ['sh'], stars: 3300, official: true, desc: 'Busybox base image.', os: 'BusyBox' },
  ubuntu: { mb: 78, kind: 'shell', cmd: ['/bin/bash'], stars: 17000, official: true, desc: 'Ubuntu is a Debian-based Linux operating system.', os: 'Ubuntu 24.04.1 LTS' },
  debian: { mb: 117, kind: 'shell', cmd: ['bash'], stars: 5100, official: true, desc: 'Debian is a Linux distribution of free software.', os: 'Debian GNU/Linux 12 (bookworm)' },
  node: { mb: 1100, kind: 'shell', cmd: ['node'], stars: 13500, official: true, desc: 'Node.js is a JavaScript runtime.', os: 'Debian GNU/Linux 12 (bookworm)', alpineMb: 132 },
  python: { mb: 1020, kind: 'shell', cmd: ['python3'], stars: 9800, official: true, desc: 'Python is an interpreted programming language.', os: 'Debian GNU/Linux 12 (bookworm)', alpineMb: 57 },
  golang: { mb: 830, kind: 'shell', cmd: ['bash'], stars: 4800, official: true, desc: 'Go (golang) is a general purpose programming language.', os: 'Debian GNU/Linux 12 (bookworm)', alpineMb: 250 },
  traefik: { mb: 180, kind: 'server', cmd: ['traefik'], port: 80, stars: 3300, official: true, desc: 'Traefik, the cloud native edge router.', os: 'Alpine Linux v3.20', log: ['level=info msg="Traefik version 3.2.0 built on 2026-10-28"'] },
  'hello-world': { mb: 0.013, kind: 'once', cmd: ['/hello'], stars: 2300, official: true, desc: 'Hello World! (an example of minimal Dockerization).', os: 'scratch', log: ['', 'Hello from Docker!', 'This message shows that your installation appears to be working correctly.', '', 'To generate this message, Docker took the following steps:', ' 1. The Docker client contacted the Docker daemon.', ' 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.', ' 3. The Docker daemon created a new container from that image which runs the', '    executable that produces the output you are currently reading.', ' 4. The Docker daemon streamed that output to the Docker client, which sent it', '    to your terminal.'] },
  registry: { mb: 25, kind: 'server', cmd: ['/etc/docker/registry/config.yml'], entrypoint: ['registry', 'serve'], port: 5000, stars: 4100, official: true, desc: 'Distribution implementation for storing and distributing container images.', os: 'Alpine Linux v3.20', log: ['level=info msg="listening on [::]:5000"'], registry: true },
  'bitnami/nginx': { mb: 190, kind: 'server', cmd: ['/opt/bitnami/scripts/nginx/run.sh'], port: 8080, stars: 190, official: false, desc: 'Bitnami container image for NGINX.', os: 'Debian GNU/Linux 12 (bookworm)' },
  'nginxinc/nginx-unprivileged': { mb: 192, kind: 'server', cmd: ['nginx', '-g', 'daemon off;'], port: 8080, stars: 160, official: false, desc: 'Unprivileged NGINX Dockerfiles.', os: 'Debian GNU/Linux 12 (bookworm)', user: 'nginx' },
};
Object.values(HUB).forEach((info) => { info.platforms ??= ARCHES; });

export const hubInfo = (repo) => HUB[repo] || HUB[repo.replace(/^library\//, '')];

// Every Linux image gets these, plus its own entries from HUB.files.
export const baseFiles = (info = {}) => ({
  '/etc/os-release': `PRETTY_NAME="${info.os || 'Linux'}"`,
  '/etc/hostname': '',
  '/etc/hosts': '127.0.0.1\tlocalhost',
  '/tmp/.keep': '',
  '/root/.keep': '',
  '/bin/sh': '',
  ...(info.files || {}),
});

export const DOCKERFILE = [
  'FROM node:20-alpine',
  'WORKDIR /app',
  'COPY package*.json ./',
  'RUN npm ci --omit=dev',
  'COPY . .',
  'EXPOSE 3000',
  'CMD ["node", "server.js"]',
].join('\n');

export const DOCKERFILE_MULTI = [
  '# syntax=docker/dockerfile:1',
  'FROM node:20 AS build',
  'WORKDIR /src',
  'COPY package*.json ./',
  'RUN npm ci',
  'COPY . .',
  'RUN npm run build',
  '',
  'FROM nginx:alpine',
  'COPY --from=build /src/dist /usr/share/nginx/html',
  'EXPOSE 80',
].join('\n');

export const COMPOSE_YAML = `services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
    depends_on:
      - api
  api:
    build: .
    environment:
      DATABASE_URL: postgres://postgres:example@db:5432/app
    depends_on:
      - db
    develop:
      watch:
        - action: sync
          path: .
          target: /app
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: example
    volumes:
      - dbdata:/var/lib/postgresql/data

volumes:
  dbdata:`;

export const STACK_YAML = `services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
  cache:
    image: redis:7
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password
    deploy:
      placement:
        constraints: [node.role == manager]

secrets:
  db_password:
    external: true`;

export const PROJECT_DIR = '/home/you/project';

export const PROJECT_FILES = {
  Dockerfile: DOCKERFILE,
  'Dockerfile.multi': DOCKERFILE_MULTI,
  '.dockerignore': 'node_modules\n.git\n*.tar\n.env',
  'compose.yaml': COMPOSE_YAML,
  'stack.yaml': STACK_YAML,
  'package.json': '{\n  "name": "myapp",\n  "version": "1.0.0",\n  "scripts": { "start": "node server.js", "build": "mkdir -p dist && cp index.html dist/" },\n  "dependencies": { "express": "^4.21.0" }\n}',
  'package-lock.json': '{ "lockfileVersion": 3 }',
  'server.js': "const http = require('http');\nhttp.createServer((req, res) => res.end('hi from my container\\n')).listen(3000);",
  'index.html': '<h1>Hello from my own page!</h1>',
  '.env': 'APP_ENV=development\nLOG_LEVEL=debug',
};
