#!/usr/bin/env bash
set -o errexit

apt-get update
apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev

