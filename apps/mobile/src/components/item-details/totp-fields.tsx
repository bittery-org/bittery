import { Card } from "heroui-native";
import { useState } from "react";
import { TotpDisplay } from "../totp-display";
import { FieldRow } from "./field-row";
import type { ItemDetailProps } from "./types";

export function TotpFields({ item, onCopy }: ItemDetailProps) {
  const [showTotpSecret, setShowTotpSecret] = useState(false);

  return (
    <>
      {/* Live TOTP Code Display */}
      {item.totpSecret && (
        <Card variant="default" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-2">Current Code</Card.Description>
            <TotpDisplay
              totpSecret={item.totpSecret}
              totpAlgorithm={item.totpAlgorithm}
              totpDigits={item.totpDigits}
              totpPeriod={item.totpPeriod}
            />
          </Card.Body>
        </Card>
      )}

      <FieldRow
        label="Secret"
        value={item.totpSecret}
        onCopy={onCopy}
        options={{
          masked: true,
          showState: showTotpSecret,
          setShowState: setShowTotpSecret,
        }}
      />
      <FieldRow label="Issuer" value={item.totpIssuer} onCopy={onCopy} />
      <FieldRow label="Account" value={item.totpAccountName} onCopy={onCopy} />

      {/* Show TOTP settings if non-default */}
      {item.totpAlgorithm && item.totpAlgorithm !== "SHA1" && (
        <Card variant="default" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">Algorithm</Card.Description>
            <Card.Title className="font-normal text-base">
              {item.totpAlgorithm}
            </Card.Title>
          </Card.Body>
        </Card>
      )}

      {item.totpDigits && item.totpDigits !== 6 && (
        <Card variant="default" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">Digits</Card.Description>
            <Card.Title className="font-normal text-base">
              {item.totpDigits}
            </Card.Title>
          </Card.Body>
        </Card>
      )}

      {item.totpPeriod && item.totpPeriod !== 30 && (
        <Card variant="default" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">Period</Card.Description>
            <Card.Title className="font-normal text-base">
              {item.totpPeriod} seconds
            </Card.Title>
          </Card.Body>
        </Card>
      )}
    </>
  );
}
