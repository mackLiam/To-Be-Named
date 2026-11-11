"""Leg estimator v1 (SCAN-V3-PLAN.md sections 4 and 6.2; contract in docs/ESTIMATOR-V1.md).

Pure numpy: observations from any capture source, a versioned prior, closed-form
Gaussian fusion, the fit-risk gate, and the forms.leg-model v1 output. Not wired
into the measuring step yet (Phase 1b, after the Phase 0 ground truth).
"""

from forms_pipeline.shape.model import ESTIMATOR_VERSION

__all__ = ["ESTIMATOR_VERSION"]
