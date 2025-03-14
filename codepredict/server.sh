#!/usr/bin/env bash
gunicorn -w 2 -b 0.0.0.0:8000 predictServer:app
