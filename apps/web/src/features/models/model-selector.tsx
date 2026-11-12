import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ModelOption, ModelRef } from "@amita/backend/types";
import { modelValue, sameModel } from "@amita/backend/models";
import { Button } from "@/components/ui/button";
import { MODEL_COPY as C } from "./copy";

type Choice = ModelOption & { unavailable?: boolean };
export function ModelSelector({
  value,
  models,
  onChange,
  disabled,
  id,
  inheritLabel,
}: {
  value: ModelRef | null;
  models: ModelOption[];
  onChange: (model: ModelRef | null) => void;
  disabled?: boolean;
  id?: string;
  inheritLabel?: string;
}) {
  const choices: Choice[] = [...models];
  if (inheritLabel) choices.unshift({ provider: "", providerName: "", id: "", name: inheritLabel });
  let selected: Choice | null = value
    ? (choices.find((option) =>
        sameModel(value, { provider: option.provider, modelId: option.id }),
      ) ?? null)
    : inheritLabel
      ? choices[0]
      : null;
  if (value && !selected) {
    selected = {
      provider: value.provider,
      providerName: value.provider,
      id: value.modelId,
      name: `${value.modelId} (unavailable)`,
      unavailable: true,
    };
    choices.push(selected);
  }
  const grouped = new Map<string, Choice[]>();
  for (const choice of choices) {
    const items = grouped.get(choice.providerName);
    if (items) items.push(choice);
    else grouped.set(choice.providerName, [choice]);
  }
  const groups = [...grouped].map(([value, items]) => ({ value, items }));
  const label = selected
    ? selected.providerName
      ? `${selected.providerName} / ${selected.name}`
      : selected.name
    : C.choose;
  return (
    <Combobox.Root
      items={groups}
      value={selected}
      disabled={disabled}
      itemToStringLabel={(option: Choice) => `${option.providerName} ${option.name} ${option.id}`}
      isItemEqualToValue={(a: Choice, b: Choice) => a.provider === b.provider && a.id === b.id}
      onValueChange={(option: Choice | null) => {
        if (option && !option.unavailable)
          onChange(option.provider ? { provider: option.provider, modelId: option.id } : null);
      }}
    >
      <Combobox.Trigger
        id={id}
        aria-label={label}
        render={
          <Button type="button" variant="outline" className="w-full min-w-0 justify-between" />
        }
      >
        <span className="truncate">{label}</span>
        <ChevronsUpDown className="size-4 shrink-0" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} className="z-50 max-w-[calc(100vw-2rem)]">
          <Combobox.Popup className="w-[max(var(--anchor-width),18rem)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
            <Combobox.Input
              aria-label={C.search}
              placeholder={C.search}
              className="mb-1 h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus:border-ring"
            />
            <Combobox.Empty className="p-3 text-sm text-muted-foreground">
              {C.noMatch}
            </Combobox.Empty>
            <Combobox.List className="max-h-72 overflow-y-auto overscroll-contain">
              {(group: { value: string; items: Choice[] }) => (
                <Combobox.Group key={group.value} items={group.items}>
                  {group.value && (
                    <Combobox.GroupLabel className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                      {group.value}
                    </Combobox.GroupLabel>
                  )}
                  <Combobox.Collection>
                    {(option: Choice) => (
                      <Combobox.Item
                        key={modelValue({ provider: option.provider, modelId: option.id })}
                        value={option}
                        disabled={option.unavailable}
                        className="flex min-h-10 cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-highlighted:bg-accent data-disabled:opacity-50"
                      >
                        <span className="min-w-0 flex-1 break-words">{option.name}</span>
                        <Combobox.ItemIndicator>
                          <Check className="size-4" />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
