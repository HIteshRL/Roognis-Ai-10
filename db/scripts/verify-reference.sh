#!/usr/bin/env bash
# Verify the LMS reference copy against an explicit LMS service checkout.
# The db repository documents schemas only; it never owns or runs migrations.
set -euo pipefail

reference_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
authority_root="${1:-}"

if [[ -z "$authority_root" ]]; then
  echo "Usage: $0 /absolute/path/to/lms-services-backend/services/lms" >&2
  exit 64
fi

if [[ ! -d "$authority_root/alembic" || ! -f "$authority_root/models.py" ]]; then
  echo "LMS authority path must contain models.py and alembic/: $authority_root" >&2
  exit 64
fi

for relative_path in models.py database.py alembic.ini; do
  if ! cmp -s "$authority_root/$relative_path" "$reference_root/schemas/lms/$relative_path"; then
    echo "LMS reference drift: $relative_path" >&2
    exit 1
  fi
done

if ! diff -qr --exclude='__pycache__' "$authority_root/alembic" "$reference_root/schemas/lms/alembic"; then
  echo "LMS reference drift: alembic migration chain" >&2
  exit 1
fi

echo "LMS reference matches the supplied LMS service authority."
