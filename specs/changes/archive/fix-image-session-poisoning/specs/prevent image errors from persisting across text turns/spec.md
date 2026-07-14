# prevent image errors from persisting across text turns

## MODIFIED Requirements

- `AgentRunner.prompt()` checks whether the resolved model supports image input before sending multimodal content to the session.
- If the model does NOT support images, `prompt()` throws a `ModelNotCapableError` with the model name and missing capability (`"image"`).
- The Telegram layer catches `ModelNotCapableError` from `AgentRunner.prompt()` and replies to the user with the error message.
- After a rejected image prompt, subsequent text-only prompts SHALL proceed normally without error.

#### Scenario: Text-only prompt with any model

- **GIVEN** any active model
- **WHEN** the user sends a text-only message
- **THEN** `prompt()` proceeds normally
- **AND** no capability check is performed

#### Scenario: Image prompt with image-capable model

- **GIVEN** a model whose capabilities include image input
- **WHEN** the user sends a photo
- **THEN** the image is delivered to the model as multimodal content
- **AND** no error is thrown

#### Scenario: Image prompt with non-image model

- **GIVEN** a model that does not support image input
- **WHEN** the user sends a photo
- **THEN** `AgentRunner.prompt()` throws `ModelNotCapableError`
- **AND** the user receives: `❌ Model "<modelName>" does not support image input.`
- **AND** the `AgentSession` state remains unchanged

#### Scenario: Text prompt after rejected image

- **GIVEN** a previous image prompt was rejected because the model doesn't support images
- **WHEN** the user sends a text-only message
- **THEN** the text prompt is processed normally
- **AND** no image-related error is raised
