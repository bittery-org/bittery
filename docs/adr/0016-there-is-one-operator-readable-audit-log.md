# There is one operator-readable audit log

Status: accepted

Bittery keeps one operator-readable log for administrative and operational events. It is explicitly
operator-controlled evidence and no security guarantee depends on it. The previous encrypted Security
History required a second event system, extra key hierarchy and separate retention behavior without
letting a client trust a malicious operator's account of events. This decision removes that system and
the Team History Key, and supersedes ADR-0003.
