#!/bin/sh
set -eu

acceptance_directory=$1
repository_directory=$2
user_directory=$3
driver_binary=$4
webkit_binary=$5
driver_port=$6
webkit_port=$7
application_binary=$8

# Mount a temporary home without changing HOME. A new user namespace plus a fresh session
# keyring below isolates linux-native/keyutils from the user's existing persistent keyring.
exec bwrap --unshare-all --share-net --die-with-parent \
  --ro-bind / / --proc /proc --dev /dev --tmpfs /tmp \
  --ro-bind /tmp/.X11-unix /tmp/.X11-unix \
  --ro-bind "$XAUTHORITY" /tmp/acceptance-Xauthority \
  --setenv XAUTHORITY /tmp/acceptance-Xauthority \
  --bind "$acceptance_directory/home" "$user_directory" \
  --ro-bind "$repository_directory" "$repository_directory" \
  --bind "$acceptance_directory" "$acceptance_directory" \
  --ro-bind "$driver_binary" "$driver_binary" \
  --ro-bind "$webkit_binary" "$webkit_binary" \
  --ro-bind "$application_binary" "$application_binary" \
  --setenv XDG_DATA_HOME "$acceptance_directory/data" \
  --setenv XDG_CONFIG_HOME "$acceptance_directory/config" \
  --setenv XDG_CACHE_HOME "$acceptance_directory/cache" \
  --setenv XDG_RUNTIME_DIR "$acceptance_directory/run" \
  --setenv TMPDIR "$acceptance_directory/tmp" \
  --setenv GDK_BACKEND x11 --setenv LIBGL_ALWAYS_SOFTWARE 1 \
  -- dbus-run-session -- /usr/bin/python3 - "$driver_binary" "$driver_port" "$webkit_port" "$webkit_binary" <<'PY'
import ctypes
import os
import sys

keyutils = ctypes.CDLL("libkeyutils.so.1", use_errno=True)
if keyutils.keyctl_join_session_keyring(None) < 0:
    raise OSError(ctypes.get_errno(), "Cannot isolate the acceptance keyring")
driver, port, native_port, native_driver = sys.argv[1:]
os.execv(driver, [driver, "--port", port, "--native-port", native_port, "--native-driver", native_driver])
PY
