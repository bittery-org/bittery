# Every route to the account keys consumes two factors

Status: accepted

`AUTH-001` used to say the master password and the Secret Key "jointly protect account encryption",
and the corpus then defined paths that defeated the claim with one artifact: a Recovery Key holding a
second wrapping of the account keys, and an Emergency Kit printing every secret on one page. Nothing
stated the exception. An implementer reading the old wording would have designed a two-secret system
and shipped three one-secret bypasses.

Two framings were on the table. The first says the second secret exists only to cover a weak human
password, so a machine-generated secret of 128 bits or more may stand alone: under that rule a
Recovery Key alone is fine and the corpus needs only an honest exception clause. The second says the
count is the rule: **every route consumes two independent factors**, and the routes are a closed list.

The second is what `AUTH-001` now says, for one reason. The entropy framing is correct about guessing
and silent about theft, and every recovery artifact this product has is a physical object. A recovery
sheet in a drawer, photographed once, is a total loss under the entropy rule and inert under the
two-factor rule. Deriving the recovery wrapping key from the Recovery Key **and** the Secret Key
together costs one extra HKDF input and buys exactly that.

The closed list is the other half. Three routes exist: master password plus Secret Key, Recovery Key
plus Secret Key, and an enrolled Device plus whatever local authorization its Device Unlock Wrapper
requires. A rule with no list decays, because the fourth route always arrives as a convenience
feature, so `AUTH-029` renders the list as a screen built from real state. A route the product grows
without amending `AUTH-001` shows up there as a defect.

Splitting the printed material follows from the same rule. `AUTH-022` puts the Secret Key on the
Emergency Kit and the Recovery Key on a separate sheet, with no field for writing the master password
on either. One page carrying both factors would satisfy the cryptography and defeat the design in a
filing cabinet.

## Considered options

**The entropy rule, allowing a single 128-bit artifact to stand alone,** was rejected: it is honest
about guessing and blind to a photograph of a sheet of paper.

**Dropping the joint-protection claim and describing each path on its own** was rejected. It is
accurate, and it constrains nothing, so the next path can be weaker than every existing one with no
requirement to amend.

**One document holding both secrets, as the frozen product printed,** was rejected. It reduces the
whole design to advice about where to file a page.

**A blank line on the Kit for the master password,** which is common practice elsewhere, was rejected
for the same reason and the Kit prints a line against it instead.

**No Recovery Key at all** was considered seriously, since a User with one enrolled Device can already
be given a way back in. It was rejected because "forgot the password and lost every Device" is the
case the artifact exists for, and `AUTH-005` makes that loss permanent.

## Consequences

A Recovery Key alone opens nothing, so losing the Emergency Kit disables the recovery route as well as
the password route. The Kit is now load-bearing twice over, which is why `AUTH-023` refuses to finish
Account creation until it is saved.

`CRYPTO-011`'s label registry gained `bittery/1/recovery-auth/1`, and both recovery labels consume two
secrets rather than one.

`AUTH-030` revocation gets stronger than it would otherwise be. A leaked recovery sheet is useless
without the Secret Key, so deleting the Server's copies is a real defence against a thief, and only an
operator holding backups defeats it. ADR 0013 records that limit.

The Device Unlock Wrapper must stay a genuine two-factor route: Device possession plus local
authorization. A quick-unlock design that opens the Account Key Set from Device state alone would add
a fourth route without saying so, and ticket 12 owns that constraint.
