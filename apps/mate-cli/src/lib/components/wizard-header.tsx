import { Box, Text } from "ink";

interface WizardHeaderProps {
  title: string;
  step: number;
  totalSteps: number;
}

export function WizardHeader({ title, step, totalSteps }: WizardHeaderProps) {
  const showStepCounter = totalSteps > 1;

  return (
    <Box borderStyle="round" width="100%">
      <Box flexDirection="column" flexGrow={1} marginLeft={1}>
        <Text bold color="green">
          mate framework
        </Text>
        <Box justifyContent="space-between">
          <Text dimColor>· {title}</Text>
          {showStepCounter ? (
            <Text dimColor>
              {step + 1} / {totalSteps}{" "}
            </Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
