import { useEffect, useId, useState } from "react";
import type { NormalizedZone } from "../types";
import "./StartBodyRegionEditor.css";

type Coordinates = Record<"left" | "top" | "right" | "bottom", string>;
const fields = ["left", "top", "right", "bottom"] as const;
const coordinates = (zone?: NormalizedZone): Coordinates => zone
  ? { left: String(zone.x1 * 100), top: String(zone.y1 * 100), right: String(zone.x2 * 100), bottom: String(zone.y2 * 100) }
  : { left: "", top: "", right: "", bottom: "" };

export function StartBodyRegionEditor({ zone, disabled, onApply }: {
  zone?: NormalizedZone; disabled: boolean; onApply: (zone: NormalizedZone) => boolean;
}) {
  const id = useId();
  const [values, setValues] = useState(() => coordinates(zone));
  const [error, setError] = useState("");
  useEffect(() => { setValues(coordinates(zone)); setError(""); }, [zone]);

  function apply() {
    const numbers = fields.map(field => values[field].trim() === "" ? NaN : Number(values[field]));
    const [left, top, right, bottom] = numbers;
    if (numbers.some(value => !Number.isFinite(value) || value < 0 || value > 100) || right <= left || bottom <= top) {
      setError("Enter all four edges from 0 to 100. Right must be greater than left, and bottom greater than top.");
      return;
    }
    const applied = onApply({ id: "startBody", label: "Start Body Zone", x1: left / 100, y1: top / 100, x2: right / 100, y2: bottom / 100 });
    setError(applied ? "" : "Climber region must span more than 0.5% of the image in both width and height.");
  }

  return <fieldset disabled={disabled} className="body-region-editor" aria-describedby={`${id}-help`}>
    <legend>Climber region with keyboard</legend>
    <p id={`${id}-help`} className="muted">Enter edges as percentages of the captured image, measured from its left and top. Enclose your climber and exclude the other lane. Apply changes only when the region matches the image.</p>
    <div className="form-grid">
      {fields.map(field => <label key={field} htmlFor={`${id}-${field}`}>
        {field[0].toUpperCase() + field.slice(1)} edge (%)
        <input id={`${id}-${field}`} type="number" min="0" max="100" step="any" inputMode="decimal"
          value={values[field]} onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))} />
      </label>)}
    </div>
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" onClick={apply}>Apply climber region</button>
  </fieldset>;
}
