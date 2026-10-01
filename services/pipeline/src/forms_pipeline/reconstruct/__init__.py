"""Photo-scan reconstruction step: photo bundle -> metric ankle-to-knee mesh (mm).

Errors are typed at the raise site (root CLAUDE.md playbook 4). Both classes below
mean "the same upload will never succeed": the user must rescan. Their messages
are user-facing and land in pipeline_jobs.error, so they never carry paths,
poses, vertices or image bytes.
"""


class BundleValidationError(ValueError):
    """The uploaded capture bundle (capture.json or a JPEG) violates the contract."""


class ReconstructionQualityError(RuntimeError):
    """The photos reconstructed badly: too few cameras, bad alignment, no leg found."""
