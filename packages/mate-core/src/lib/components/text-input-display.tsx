import { Box, Text } from "ink";

interface TextInputDisplayProps {
  value: string;
  error?: string;
}

export function TextInputDisplay({ value, error }: TextInputDisplayProps) {
  return (
    <>
      <Box marginTop={1}>
        <Text>
          {">"} {value}
          <Text inverse> </Text>
        </Text>
      </Box>
      {error && <Text color="red">{error}</Text>}
    </>
  );
}
