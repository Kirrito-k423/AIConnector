#!/bin/zsh
set -e
cd -- "${0:A:h}"
if [[ -x runtime/node ]]; then
  exec runtime/node service/cli.mjs open "$@"
else
  exec node service/cli.mjs open "$@"
fi
