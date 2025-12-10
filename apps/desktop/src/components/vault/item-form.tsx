/** biome-ignore-all lint/suspicious/noArrayIndexKey: Using array index as key is acceptable here because the list order is stable and items do not get reordered */

import { Button, Input, Label, PasswordGenerator, toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { Plus, Trash2, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";

export interface CustomField {
  id: string;
  label: string;
  value: string;
  type: "text" | "password" | "email" | "url";
}

interface LoginFormData {
  title: string;
  url: string;
  urls?: string[];
  username: string;
  password: string;
  notes: string;
  customFields?: CustomField[];
}

interface SecureNoteFormData {
  title: string;
  note: string;
}

interface ItemFormProps {
  category: "login" | "secure-note";
  initialData?: Partial<LoginFormData | SecureNoteFormData>;
  onSubmit: (data: LoginFormData | SecureNoteFormData) => Promise<void> | void;
  onCancel: () => void;
  submitLabel?: string;
  isSubmitting?: boolean;
}

export function ItemForm(props: ItemFormProps) {
  if (props.category === "login") {
    return <LoginForm {...props} />;
  }
  return <SecureNoteForm {...props} />;
}

function LoginForm({
  initialData,
  onSubmit,
  onCancel,
  submitLabel = "Save",
  isSubmitting = false,
}: Omit<ItemFormProps, "category">) {
  const initialLoginData = initialData as Partial<LoginFormData>;

  const [additionalUrls, setAdditionalUrls] = useState<string[]>(
    initialLoginData?.urls || []
  );
  const [customFields, setCustomFields] = useState<CustomField[]>(
    initialLoginData?.customFields || []
  );

  const form = useForm({
    defaultValues: {
      title: initialLoginData?.title || "",
      url: initialLoginData?.url || "",
      username: initialLoginData?.username || "",
      password: initialLoginData?.password || "",
      notes: initialLoginData?.notes || "",
    },
    onSubmit: async ({ value }) => {
      try {
        const submitData = {
          ...value,
          urls: additionalUrls.length > 0 ? additionalUrls : undefined,
          customFields: customFields.length > 0 ? customFields : undefined,
        };
        await onSubmit(submitData);
        toast.success("Item saved successfully");
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to save item";
        toast.error(errorMessage);
      }
    },
  });

  const handleGeneratePassword = (password: string) => {
    form.setFieldValue("password", password);
    toast.success("Password generated");
  };

  const addAdditionalUrl = () => {
    setAdditionalUrls([...additionalUrls, ""]);
  };

  const updateAdditionalUrl = (index: number, value: string) => {
    const updated = [...additionalUrls];
    updated[index] = value;
    setAdditionalUrls(updated);
  };

  const removeAdditionalUrl = (index: number) => {
    setAdditionalUrls(additionalUrls.filter((_, i) => i !== index));
  };

  const addCustomField = () => {
    setCustomFields([
      ...customFields,
      { id: nanoid(), label: "", value: "", type: "text" },
    ]);
  };

  const updateCustomField = (id: string, field: Partial<CustomField>) => {
    setCustomFields(
      customFields.map((cf) => (cf.id === id ? { ...cf, ...field } : cf))
    );
  };

  const removeCustomField = (id: string) => {
    setCustomFields(customFields.filter((cf) => cf.id !== id));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
      className="flex flex-1 flex-col overflow-hidden"
    >
      <div className="flex-1 space-y-4 overflow-y-auto py-1 pr-2">
        <div>
          <form.Field name="title">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>Title *</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="My Account"
                  required
                />
              </div>
            )}
          </form.Field>
        </div>

        <div>
          <form.Field name="url">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>Website</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  type="url"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="https://example.com"
                />
              </div>
            )}
          </form.Field>
        </div>

        <div>
          <form.Field name="username">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>Username</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="user@example.com"
                />
              </div>
            )}
          </form.Field>
        </div>

        <div>
          <form.Field name="password">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>Password</Label>
                <div className="flex gap-2">
                  <Input
                    id={field.name}
                    name={field.name}
                    type="password"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="••••••••••"
                    className="flex-1 font-mono"
                  />
                  <PasswordGenerator
                    onPasswordGenerated={handleGeneratePassword}
                    showCopyButton={false}
                  />
                </div>
              </div>
            )}
          </form.Field>
        </div>

        <div>
          <form.Field name="notes">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>Notes</Label>
                <textarea
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Additional notes..."
                  rows={4}
                  className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            )}
          </form.Field>
        </div>

        {/* Additional URLs */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Additional Websites</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addAdditionalUrl}
            >
              <Plus className="mr-1 size-3" />
              Add URL
            </Button>
          </div>
          {additionalUrls.map((url, index) => (
            <div key={index} className="flex gap-2">
              <Input
                type="url"
                value={url}
                onChange={(e) => updateAdditionalUrl(index, e.target.value)}
                placeholder="https://example.com"
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeAdditionalUrl(index)}
              >
                <X size={16} />
              </Button>
            </div>
          ))}
        </div>

        {/* Custom Fields */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Custom Fields</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addCustomField}
            >
              <Plus className="mr-1 size-3" />
              Add Field
            </Button>
          </div>
          {customFields.map((field) => (
            <div key={field.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex gap-2">
                <Input
                  placeholder="Field label"
                  value={field.label}
                  onChange={(e) =>
                    updateCustomField(field.id, { label: e.target.value })
                  }
                  className="flex-1"
                />
                <select
                  value={field.type}
                  onChange={(e) =>
                    updateCustomField(field.id, {
                      type: e.target.value as CustomField["type"],
                    })
                  }
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="text">Text</option>
                  <option value="password">Password</option>
                  <option value="email">Email</option>
                  <option value="url">URL</option>
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeCustomField(field.id)}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
              <Input
                type={field.type === "password" ? "password" : "text"}
                placeholder="Value"
                value={field.value}
                onChange={(e) =>
                  updateCustomField(field.id, { value: e.target.value })
                }
              />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex gap-2 border-t bg-background pt-4">
        <Button type="submit" className="flex-1" disabled={isSubmitting}>
          {isSubmitting ? "Saving..." : submitLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SecureNoteForm({
  initialData,
  onSubmit,
  onCancel,
  submitLabel = "Save",
  isSubmitting = false,
}: Omit<ItemFormProps, "category">) {
  const form = useForm({
    defaultValues: {
      title: (initialData as Partial<SecureNoteFormData>)?.title || "",
      note: (initialData as Partial<SecureNoteFormData>)?.note || "",
    },
    onSubmit: async ({ value }) => {
      try {
        await onSubmit(value);
        toast.success("Note saved successfully");
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to save note";
        toast.error(errorMessage);
      }
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
      className="flex flex-1 flex-col overflow-hidden"
    >
      <div className="flex-1 space-y-4 overflow-y-auto py-1 pr-2">
        <div>
          <form.Field name="title">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor={field.name}>Title *</Label>
              <Input
                id={field.name}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="My Secure Note"
                required
              />
            </div>
          )}
        </form.Field>
      </div>

      <div>
        <form.Field name="note">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor={field.name}>Note Content *</Label>
              <textarea
                id={field.name}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="Write your secure note here..."
                rows={12}
                required
                className="flex min-h-60 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          )}
        </form.Field>
        </div>
      </div>

      <div className="mt-4 flex gap-2 border-t bg-background pt-4">
        <Button type="submit" className="flex-1" disabled={isSubmitting}>
          {isSubmitting ? "Saving..." : submitLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
