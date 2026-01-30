/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import {
  formatAddress,
  formatPhoneNumber,
  maskDriversLicense,
  maskPassportNumber,
  maskSSN,
} from "@bittery/shared/identity";
import { Button, Card, Label } from "@bittery/ui";
import { Copy } from "lucide-react";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import {
  DetailField,
  DetailHeader,
  DetailPasswordField,
  DetailSection,
} from "./field-components";
import {
  type CategoryDetailProps,
  handleCopy,
  type IdentityDisplayData,
} from "./shared";

export function IdentityDetail({
  data,
  onEdit,
  onDelete,
  onTagsChange,
  onTagClick,
  availableTags = [],
  isUpdatingTags,
}: CategoryDetailProps<IdentityDisplayData>) {
  const fullName = [data.firstName, data.middleName, data.lastName]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-4">
      <DetailHeader
        icon={<Favicon title={data.title} category="identity" size="lg" />}
        title={data.title}
        subtitle={fullName}
      />

      <div className="flex gap-2">
        {onEdit && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit
          </Button>
        )}
        {onDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
          >
            Delete
          </Button>
        )}
      </div>

      <div className="space-y-3">
        {(data.firstName ||
          data.lastName ||
          data.email ||
          data.dateOfBirth) && (
          <DetailSection title="Personal Information">
            <DetailField label="First Name" value={data.firstName} />
            <DetailField label="Middle Name" value={data.middleName} />
            <DetailField label="Last Name" value={data.lastName} />
            <DetailField label="Email" value={data.email} />
            <DetailField label="Date of Birth" value={data.dateOfBirth} />
          </DetailSection>
        )}

        {data.phoneNumbers && data.phoneNumbers.length > 0 && (
          <div className="space-y-3">
            <Label className="font-medium text-sm">Phone Numbers</Label>
            {data.phoneNumbers.map((phone) => (
              <DetailField
                key={phone.id}
                label={phone.label}
                value={formatPhoneNumber(phone.number)}
              />
            ))}
          </div>
        )}

        {data.addresses && data.addresses.length > 0 && (
          <div className="space-y-3">
            <Label className="font-medium text-sm">Addresses</Label>
            {data.addresses.map((address) => (
              <div key={address.id} className="space-y-2">
                <Card>
                  <div className="px-4 py-3">
                    <div className="text-sm">{formatAddress(address)}</div>
                  </div>
                </Card>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleCopy(formatAddress(address), "Address")}
                  className="w-full"
                >
                  <Copy size={16} className="mr-2" />
                  Copy Address
                </Button>
              </div>
            ))}
          </div>
        )}

        {(data.ssn || data.passportNumber || data.driversLicense) && (
          <DetailSection title="Government IDs">
            {data.ssn && (
              <DetailPasswordField
                label="Social Security Number"
                value={data.ssn}
                maskValue={maskSSN(data.ssn)}
              />
            )}
            {data.passportNumber && (
              <DetailPasswordField
                label="Passport Number"
                value={data.passportNumber}
                maskValue={maskPassportNumber(data.passportNumber)}
              />
            )}
            {data.driversLicense && (
              <DetailPasswordField
                label="Driver's License"
                value={data.driversLicense}
                maskValue={maskDriversLicense(data.driversLicense)}
              />
            )}
          </DetailSection>
        )}

        {data.notes && (
          <div className="space-y-2">
            <Label className="font-medium text-sm">Notes</Label>
            <Card>
              <div className="whitespace-pre-wrap px-4 py-1 text-sm">
                {data.notes}
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* Tags */}
      {onTagsChange && (
        <div className="space-y-2">
          <Label>Tags</Label>
          <TagInput
            tags={data.tags || []}
            availableTags={availableTags}
            onChange={onTagsChange}
            onTagClick={onTagClick}
            disabled={isUpdatingTags}
          />
        </div>
      )}
    </div>
  );
}
