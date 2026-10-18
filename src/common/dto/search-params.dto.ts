import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsNumberString,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  MaxLength,
} from "class-validator";

export class LibrarySearchParamsDto {
  @ApiProperty({ description: "Exact Telegram search query" })
  @IsString()
  @MaxLength(1024)
  search: string;
}

export class MovieSearchDto {
  @ApiProperty({
    description: 'IMDB ID or TMDB ID (prefixed with "tmdb:")',
    example: "tt1375666",
  })
  @IsString()
  @IsNotEmpty()
  imdb_id: string;
}

export class SeriesSearchDto {
  @ApiProperty({
    description: 'IMDB ID or TMDB ID (prefixed with "tmdb:")',
    example: "tt0944947",
  })
  @IsString()
  @IsNotEmpty()
  imdb_id: string;
}

export class EpisodeParamsDto {
  @ApiProperty({
    description: 'IMDB ID or TMDB ID (prefixed with "tmdb:")',
    example: "tt0944947",
  })
  @IsString()
  @IsNotEmpty()
  imdbId: string;

  @ApiProperty({
    description: "Season number",
    example: "1",
  })
  @IsNumberString()
  season: string;

  @ApiProperty({
    description: "Episode number",
    example: "1",
  })
  @IsNumberString()
  episode: string;
}

export class StreamParamsDto {
  @ApiProperty({
    description: "Media type",
    example: "movie",
    enum: ["movie", "series"],
  })
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiProperty({
    description: "ID with optional episode info",
    example: "tt1375666",
  })
  @IsString()
  @IsNotEmpty()
  idWithEpisode: string;
}

@ValidatorConstraint({ name: "telegramInteger", async: false })
export class TelegramIntegerConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== "string" || !/^-?[1-9][0-9]{0,18}$/.test(value)) return false;
    const integer = BigInt(value);
    const [minimum, maximum] = args.constraints as [bigint, bigint];
    return integer >= minimum && integer <= maximum;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a nonzero decimal integer in the supported Telegram range`;
  }
}

export class WatchParamsDto {
  @ApiProperty({ description: "Positive Telegram peer ID", example: "1234567890" })
  @Validate(TelegramIntegerConstraint, [1n, 9223372036854775807n])
  chatId: string;

  @ApiProperty({ description: "Positive Telegram message ID", example: "12345" })
  @Validate(TelegramIntegerConstraint, [1n, 2147483647n])
  messageId: string;
}

export class HashedWatchParamsDto extends WatchParamsDto {
  @ApiProperty({ description: "Nonzero signed 64-bit peer access hash (decimal string)", example: "-987654321012345678" })
  @Validate(TelegramIntegerConstraint, [-9223372036854775808n, 9223372036854775807n])
  accessHash: string;
}
