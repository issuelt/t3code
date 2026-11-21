import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useContext, useState } from "react";

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: string | Omit<AtomCommandOptions, "signal">,
): (value: W, call?: Pick<AtomCommandOptions, "signal">) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const label = typeof options === "string" ? options : (options?.label ?? command.label);
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);

  return (value, call) =>
    runAtomCommand(registry, command, value, { label, reportFailure, reportDefect, ...call });
}

export function useCommandStatus() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <A, E>(
    send: () => Promise<AtomCommandResult<A, E>>,
    fallbackMessage: string,
  ): Promise<AtomCommandResult<A, E>> => {
    setPending(true);
    setError(null);
    const result = await send();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : fallbackMessage);
    }
    setPending(false);
    return result;
  };
  return { pending, error, run };
}
