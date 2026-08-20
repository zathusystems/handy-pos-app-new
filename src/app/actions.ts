
"use server";

import { z } from "zod";

const wizardSchema = z.object({
  businessName: z.string().min(2, "Business name must be at least 2 characters."),
  businessType: z.string().min(1, "Please select a business type."),
  currency: z.string().default("USD"),
});

export type WizardData = z.infer<typeof wizardSchema>;

export async function runHandyPosSetup(data: WizardData) {
  const validation = wizardSchema.safeParse(data);
  if (!validation.success) {
    return {
      success: false,
      error: "Invalid data provided.",
    };
  }

  // Here you would typically save the configuration to your backend.
  // For this demo, we'll just log it and return success.
  console.log("Setup data:", validation.data);

  return {
    success: true,
    data: {
      message: "Setup completed successfully!",
    }
  };
}
