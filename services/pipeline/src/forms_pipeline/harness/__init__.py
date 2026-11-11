"""Local video harness: forms-video bundles -> production silhouette math -> ratios.

Local tool only (docs/VIDEO-HARNESS.md). It never touches the network and writes
only under its --out directory. Plain video carries no scale, so every result is
a ratio; absolute values are labelled nominal.
"""


class HarnessBundleError(ValueError):
    """A video bundle violates forms.video-bundle v1. The message is a short reason."""
