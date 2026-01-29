"""Embedder module using Google GenAI for text embeddings."""

import os
import time
from typing import Optional

from google import genai

# Singleton client instance
_client: Optional[genai.Client] = None

# Embedding configuration
EMBEDDING_MODEL = "gemini-embedding-001"
OUTPUT_DIMENSIONALITY = 768
DEFAULT_BATCH_SIZE = 100
BATCH_DELAY = 0.1  # seconds between batches
MAX_RETRIES = 3
RETRY_DELAY = 1.0  # initial delay for exponential backoff


def get_client() -> genai.Client:
    """Get or create a singleton GenAI client.

    Returns:
        genai.Client: The Google GenAI client instance.

    Raises:
        ValueError: If GOOGLE_API_KEY environment variable is not set.
    """
    global _client

    if _client is None:
        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError(
                "GOOGLE_API_KEY environment variable is not set. "
                "Please set it with your Google AI API key."
            )
        _client = genai.Client(api_key=api_key)

    return _client


def embed_text(text: str) -> list[float]:
    """Generate embeddings for a single text.

    Args:
        text: The text to embed.

    Returns:
        A list of 768 floats representing the embedding vector.

    Raises:
        ValueError: If the API key is not configured.
        Exception: If the API call fails after retries.
    """
    client = get_client()

    for attempt in range(MAX_RETRIES):
        try:
            response = client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=text,
                config={"output_dimensionality": OUTPUT_DIMENSIONALITY}
            )
            return list(response.embeddings[0].values)
        except Exception as e:
            error_str = str(e).lower()
            # Retry on rate limit errors
            if "rate" in error_str or "quota" in error_str or "429" in error_str:
                if attempt < MAX_RETRIES - 1:
                    delay = RETRY_DELAY * (2 ** attempt)
                    time.sleep(delay)
                    continue
            raise

    raise Exception(f"Failed to embed text after {MAX_RETRIES} retries")


def embed_batch(
    texts: list[str],
    batch_size: int = DEFAULT_BATCH_SIZE,
    show_progress: bool = True
) -> list[list[float]]:
    """Generate embeddings for multiple texts in batches.

    Args:
        texts: List of texts to embed.
        batch_size: Number of texts to process per API call (default: 100).
        show_progress: Whether to print progress for large batches.

    Returns:
        A list of embedding vectors, one per input text.
        Each embedding is a list of 768 floats.

    Raises:
        ValueError: If the API key is not configured.
        Exception: If the API call fails after retries.
    """
    if not texts:
        return []

    client = get_client()
    all_embeddings: list[list[float]] = []
    total_batches = (len(texts) + batch_size - 1) // batch_size

    for batch_idx in range(0, len(texts), batch_size):
        batch = texts[batch_idx:batch_idx + batch_size]
        batch_num = batch_idx // batch_size + 1

        if show_progress and total_batches > 1:
            print(f"Embedding batch {batch_num}/{total_batches} ({len(batch)} texts)...")

        # Retry logic for the batch
        for attempt in range(MAX_RETRIES):
            try:
                response = client.models.embed_content(
                    model=EMBEDDING_MODEL,
                    contents=batch,
                    config={"output_dimensionality": OUTPUT_DIMENSIONALITY}
                )

                # Extract embeddings from response
                for embedding in response.embeddings:
                    all_embeddings.append(list(embedding.values))

                break  # Success, exit retry loop

            except Exception as e:
                error_str = str(e).lower()
                # Retry on rate limit errors
                if "rate" in error_str or "quota" in error_str or "429" in error_str:
                    if attempt < MAX_RETRIES - 1:
                        delay = RETRY_DELAY * (2 ** attempt)
                        if show_progress:
                            print(f"Rate limited, waiting {delay:.1f}s before retry...")
                        time.sleep(delay)
                        continue
                raise

        # Add delay between batches to avoid rate limiting
        if batch_idx + batch_size < len(texts):
            time.sleep(BATCH_DELAY)

    if show_progress and total_batches > 1:
        print(f"Embedded {len(all_embeddings)} texts successfully.")

    return all_embeddings
