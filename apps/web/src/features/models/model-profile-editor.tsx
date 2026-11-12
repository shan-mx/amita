import { useState } from "react";
import { MODEL_REASONING_LEVELS } from "@amita/backend/config";
import { MODEL_COPY as C } from "./copy";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { ModelCandidate } from "@amita/backend/types";
type Candidate = ModelCandidate & { maxTokensField?: "max_tokens" | "max_completion_tokens" };

export function ModelProfileEditor({
  model,
  onChange,
}: {
  model: Candidate;
  onChange: (model: Candidate) => void;
}) {
  const [expanded, setExpanded] = useState(
    model.contextWindow === undefined || model.maxTokens === undefined,
  );
  return (
    <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium">
        {C.advanced} · {model.id}
      </summary>
      <div className="mt-3 grid gap-3">
        <label className="grid gap-1 text-sm">
          {C.name}
          <Input
            value={model.name}
            maxLength={256}
            onChange={(event) => onChange({ ...model, name: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-sm">
          {C.contextWindow}
          <Input
            type="number"
            min={1}
            value={model.contextWindow ?? ""}
            onChange={(event) =>
              onChange({
                ...model,
                contextWindow: Number.isNaN(event.target.valueAsNumber)
                  ? undefined
                  : event.target.valueAsNumber,
              })
            }
          />
        </label>
        <label className="grid gap-1 text-sm">
          {C.maxTokens}
          <Input
            type="number"
            min={1}
            value={model.maxTokens ?? ""}
            onChange={(event) =>
              onChange({
                ...model,
                maxTokens: Number.isNaN(event.target.valueAsNumber)
                  ? undefined
                  : event.target.valueAsNumber,
              })
            }
          />
        </label>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{C.reasoningLevels}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {MODEL_REASONING_LEVELS.map((level) => (
              <label key={level} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={model.reasoningLevels?.includes(level) ?? false}
                  onChange={(event) =>
                    onChange({
                      ...model,
                      reasoningLevels: MODEL_REASONING_LEVELS.filter((candidate) =>
                        candidate === level
                          ? event.target.checked
                          : model.reasoningLevels?.includes(candidate),
                      ),
                    })
                  }
                />
                {level}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={model.acceptsImages ?? false}
            onChange={(event) => onChange({ ...model, acceptsImages: event.target.checked })}
          />
          {C.acceptsImages}
        </label>
        <label className="grid gap-1 text-sm">
          {C.maxTokensField}
          <NativeSelect
            value={model.maxTokensField ?? "max_tokens"}
            onChange={(event) =>
              onChange({
                ...model,
                maxTokensField:
                  event.target.value === "max_completion_tokens"
                    ? "max_completion_tokens"
                    : "max_tokens",
              })
            }
          >
            <option value="max_tokens">max_tokens</option>
            <option value="max_completion_tokens">max_completion_tokens</option>
          </NativeSelect>
        </label>
      </div>
    </details>
  );
}
