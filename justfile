set shell := ["bash", "-cu"]

default:
    @just --list

install:
    npm install

build:
    npm run build

dev:
    npm run dev

login:
    npx wrangler login

whoami:
    npx wrangler whoami

deploy: build
    npx wrangler deploy

deploy-preview: build
    npx wrangler versions upload

tail:
    npx wrangler tail
