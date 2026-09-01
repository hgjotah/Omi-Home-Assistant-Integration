import { describe, expect, it } from "vitest";
import { commandDistance, commandPrefix, extractVoiceUnits, matchCommand, normalizeTranscript } from "../src/normalization";
import type { CommandRow } from "../src/types";

const command: CommandRow = {
  id: "cmd_1", uid: "u", phrase: "Omi enciende la luz", normalized_phrase: "omi enciende la luz",
  entity_id: "light.habitacion", entity_name: "Luz", domain: "light", service: "turn_on", service_data: "{}",
  enabled: 1, created_at: 0, updated_at: 0,
};

const customCommand: CommandRow = {
  ...command,
  id: "cmd_jarvis",
  phrase: "Jarvis enciende la luz",
  normalized_phrase: "jarvis enciende la luz",
};

describe("normalización y matching conservador", () => {
  it("normaliza Unicode, tildes, puntuación y espacios", () => {
    expect(normalizeTranscript("  ÓMI,   ENCIÉNDE la luz. ")).toBe("omi enciende la luz");
  });

  it("hace matching exacto después de normalizar", () => {
    const units = extractVoiceUnits([{ text: "Omi, enciende la luz." }]);
    expect(matchCommand(units, [command])?.command.id).toBe("cmd_1");
  });

  it("usa como activación la primera palabra configurada", () => {
    const units = extractVoiceUnits([{ text: "Jarvis, enciende la luz." }]);
    expect(commandPrefix(customCommand.normalized_phrase)).toBe("jarvis");
    expect(matchCommand(units, [customCommand])?.command.id).toBe("cmd_jarvis");
    expect(matchCommand(extractVoiceUnits([{ text: "Omi enciende la luz" }]), [customCommand])).toBeNull();
  });

  it("no activa sin la primera palabra configurada ni buscando un substring de conversación", () => {
    expect(matchCommand(extractVoiceUnits([{ text: "enciende la luz" }]), [command])).toBeNull();
    expect(matchCommand(extractVoiceUnits([{ text: "El comando es Omi enciende la luz" }]), [command])).toBeNull();
  });

  it("tolera como máximo un carácter trivial de STT", () => {
    expect(commandDistance("omi enciende la lus", command.normalized_phrase)).toBe(1);
    expect(commandDistance("omi por favor enciende todas las luces", command.normalized_phrase)).toBeGreaterThan(1);
  });

  it("is_user=false no autoriza ni bloquea: la frase manda", () => {
    const units = extractVoiceUnits([{ text: "Omi enciende la luz", is_user: false, start: 4, end: 6 }]);
    expect(matchCommand(units, [command])).not.toBeNull();
  });

  it("une solo segmentos recientes, del mismo hablante y ventana corta", () => {
    const units = extractVoiceUnits([
      { text: "Omi", speaker: "A", start: 1, end: 1.2 },
      { text: "enciende la luz", speaker: "A", start: 1.3, end: 2.2 },
    ]);
    expect(units.some((unit) => unit.normalized === "omi enciende la luz")).toBe(true);
  });
});
