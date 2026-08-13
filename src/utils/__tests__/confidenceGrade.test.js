import { describe, it, expect } from 'vitest';
import { gradeFromConfidence, tierFromConfidence, GRADE_THRESHOLDS } from '../confidenceGrade.js';

describe('confidenceGrade', () => {
  it('maps confidence to grades at the recalibrated cut-offs', () => {
    expect(gradeFromConfidence(90)).toBe('A');
    expect(gradeFromConfidence(GRADE_THRESHOLDS.A)).toBe('A');
    expect(gradeFromConfidence(GRADE_THRESHOLDS.A - 1)).toBe('B');
    expect(gradeFromConfidence(GRADE_THRESHOLDS.B)).toBe('B');
    expect(gradeFromConfidence(GRADE_THRESHOLDS.C)).toBe('C');
    expect(gradeFromConfidence(GRADE_THRESHOLDS.C - 1)).toBe('D');
  });

  it('tier mirrors grade', () => {
    expect(tierFromConfidence(90)).toBe('STRONG');
    expect(tierFromConfidence(GRADE_THRESHOLDS.B)).toBe('GOOD');
    expect(tierFromConfidence(GRADE_THRESHOLDS.C)).toBe('FAIR');
    expect(tierFromConfidence(0)).toBe('WEAK');
  });

  it('is defensive against non-numeric input', () => {
    expect(gradeFromConfidence(null)).toBe('D');
    expect(gradeFromConfidence(undefined)).toBe('D');
    expect(gradeFromConfidence(NaN)).toBe('D');
  });

  it('REGRESSION: realistic post-fix confidences are no longer all D', () => {
    // Measured corrected values from a real scan (sector inflation removed).
    const measured = [59, 59, 57, 51, 48];
    const grades = measured.map(gradeFromConfidence);
    expect(grades).not.toContain('D');          // old 55-cut would have D'd two of these
    expect(grades.filter(g => g === 'B').length).toBeGreaterThan(0);
  });
});
