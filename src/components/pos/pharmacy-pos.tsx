'use client';

import { Pill } from 'lucide-react';
import { GenericPos, type PosProps } from './generic-pos';

export const PharmacyPos = (props: PosProps) => {
    return <GenericPos {...props} productIcon={<Pill className="h-8 w-8 text-muted-foreground" data-ai-hint="pharmacy medicine" />} />;
}
