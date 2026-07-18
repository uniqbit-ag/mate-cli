import { Box, Text } from "ink";
import React from "react";

interface WizardFooterProps {
  hint: string;
}

export function WizardFooter({ hint }: WizardFooterProps) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
