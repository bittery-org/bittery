import { Button, Card } from "heroui-native";
import { Copy } from "lucide-react-native";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { maskValue } from "./utils";

const StyledCopy = withUniwind(Copy);

interface CustomField {
  id: string;
  label: string;
  value: string;
  type: string;
}

interface CustomFieldsProps {
  fields?: CustomField[];
  onCopy: (value: string, label: string) => Promise<void>;
}

export function CustomFields({ fields, onCopy }: CustomFieldsProps) {
  if (!fields || fields.length === 0) return null;

  return (
    <>
      {fields.map((field) => (
        <Card key={field.id} variant="secondary" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">
              {field.label}
            </Card.Description>
            <View className="flex-row items-center gap-2.5">
              <Card.Title
                className="flex-1 font-normal text-base"
                selectable
                numberOfLines={field.type === "password" ? 1 : undefined}
              >
                {field.type === "password"
                  ? maskValue(field.value)
                  : field.value}
              </Card.Title>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => onCopy(field.value, field.label)}
              >
                <StyledCopy size={18} className="text-muted" />
              </Button>
            </View>
          </Card.Body>
        </Card>
      ))}
    </>
  );
}
