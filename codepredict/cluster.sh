#!/usr/bin/env bash
port=$1
gunicorn -w 20 -b 0.0.0.0:${port} predictServer:app