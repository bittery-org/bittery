# Frozen pre-greenfield Bittery

This directory contains the tracked source tree from commit
`f021c85e1d3a9d3f3418ba67a9ff04f319987903`, tagged `legacy-v0.5.2`.

It is read-only implementation evidence for the greenfield rebuild. Greenfield modules never import,
build, modify, or depend on it. The tree is not expected to build from this nested location because
some legacy scripts assume the Git repository root is the application root.

When it no longer provides useful evidence, remove this directory through an approved greenfield
ticket. The tag preserves the original runnable tree after removal.

